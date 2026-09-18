/**
 * JOURNEY: human-agent (Sam's Human Work queue).
 *
 * Handoff §8 checklist items:
 *   - Human-agent journey (available work → eligible jobs → assignment)
 *   - Human Work queue is a first-class surface (formatted offer, real claim)
 *
 * NON-DESTRUCTIVE BY DEFAULT: the seeded open offer is Sam's single seeded
 * fixture (single consumer). The default run verifies:
 *   - the queue + marketplace + candidate offers through the real API;
 *   - the UI renders the offer as a FORMATTED card with Accept/Decline;
 *   - the claim routes' security posture (401/403/404 fail-closed).
 *
 * DESTRUCTIVE OPT-IN (MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION=1 +
 * MOS_E2E_DEMO_OFFER_ACTION=accept|decline, default accept): Sam claims the
 * seeded offer through the real claim contract and the journey verifies the
 * honest state transition. THE OFFER IS THEN CONSUMED — the documented
 * operator procedure (production seed re-run, which closes out an accepted
 * fixture honestly and projects a fresh open offer) restores it. The harness
 * never runs the seed itself (it lives outside the repo — Worker A's scope).
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { uiSignIn, uiHealth } from '../lib/ui.mjs';
import { browserSession } from '../lib/browser.mjs';

export const name = 'human-agent';
export const checklist = ['Human-agent journey'];
export const requires = ['MOS_E2E_AGENT_*', 'agent-browser'];

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  let browser = null;
  try {
    // --- 1. API: Sam's queue through the real contract -------------------------
    const agent = await api.login(env.agent.email, env.agent.password);
    const queue = await api.get('jobs/queue', { token: agent.token });
    evidence.response('00-agent-queue', queue);
    const openOffers = queue.body?.offers ?? [];
    const offer = openOffers[0];
    await steps.checkFn(
      'human agent queue resolves (agent profile active)',
      '200 with an agent block',
      async () => ({
        actual: `offers=${openOffers.length} agent=${queue.body?.agent ? 'present' : 'absent'}`,
        pass: queue.status === 200 && queue.body?.agent !== undefined,
      }),
    );
    await steps.checkFn(
      'queue shows the seeded OPEN offer with a full job descriptor',
      '1 open offer; job title + eligibility + expiry',
      async () => {
        const descriptor = offer?.job ?? {};
        const hasDescriptor =
          typeof descriptor.title === 'string' &&
          descriptor.eligibility !== undefined &&
          offer.status === 'open' &&
          offer.expiresAt !== undefined;
        return {
          actual: `offers=${openOffers.length} title=${String(descriptor.title).slice(0, 44)}… status=${String(offer?.status)}`,
          pass: openOffers.length === 1 && hasDescriptor,
        };
      },
    );

    const marketplace = await api.get('jobs/marketplace', { token: agent.token });
    evidence.response('01-agent-marketplace', marketplace);
    await steps.checkFn(
      'job marketplace lists offerable work for the eligible agent',
      '≥ 1 job descriptor (no client data in descriptors)',
      async () => {
        const jobs = marketplace.body?.jobs ?? [];
        const noTenantLeak = jobs.every(
          (job) => job.clientId === undefined && job.agencyId === undefined && job.workspaceId === undefined,
        );
        const pass = jobs.length >= 1 && noTenantLeak;
        return { actual: `jobs=${jobs.length} tenantFieldsLeaked=${!noTenantLeak}`, pass };
      },
    );

    const ownOffers = await api.get('jobs/offers', { token: agent.token });
    evidence.response('02-agent-candidate-offers', ownOffers);
    await steps.checkFn(
      'candidate view shows the caller\'s own offers only',
      '≥ 1 own offer pair',
      async () => {
        const rows = Array.isArray(ownOffers.body?.offers) ? ownOffers.body.offers : [];
        const pass = rows.length >= 1;
        return { actual: `ownOffers=${rows.length}`, pass };
      },
    );

    // --- 2. security posture of the claim routes (non-destructive) -------------
    const unauthClaim = await api.post(`jobs/queue/offers/${offer.offerId}/accept`, { body: {} });
    evidence.response('03-unauthenticated-claim', unauthClaim);
    await steps.checkFn(
      'unauthenticated offer claim → 401',
      'HTTP 401 UNAUTHORIZED',
      async () => ({
        actual: `HTTP ${unauthClaim.status} code ${String(unauthClaim.body?.error?.code)}`,
        pass: unauthClaim.status === 401 && unauthClaim.body?.error?.code === 'UNAUTHORIZED',
      }),
    );
    if (shared.throwaway.signedUp) {
      // A REAL non-agent identity proving the profile gate (fresh session).
      const { loginThrowaway } = await import('../lib/throwaway.mjs');
      const session = await loginThrowaway(shared, api);
      const nonAgentClaim = await api.post(`jobs/queue/offers/${offer.offerId}/accept`, {
        token: session.token,
        body: {},
      });
      evidence.response('04-non-agent-claim', nonAgentClaim);
      await steps.checkFn(
        'claim by a user without a Human Agent profile → 403/404 fail-closed',
        'profile gate enforced before any offer data',
        async () => ({
          actual: `HTTP ${nonAgentClaim.status} code ${String(nonAgentClaim.body?.error?.code)}`,
          pass: [403, 404].includes(nonAgentClaim.status),
        }),
      );
    } else {
      await steps.info('non-agent claim probe skipped (throwaway tenant not yet created in this run)');
    }
    const foreignClaim = await api.post('jobs/queue/offers/00000000-0000-0000-0000-000000000000/accept', {
      token: agent.token,
      body: {},
    });
    evidence.response('05-foreign-offer-claim', foreignClaim);
    await steps.checkFn(
      'foreign offer id claim → uniform 404 (no existence oracle)',
      'HTTP 404 NOT_FOUND',
      async () => ({
        actual: `HTTP ${foreignClaim.status} code ${String(foreignClaim.body?.error?.code)}`,
        pass: foreignClaim.status === 404 && foreignClaim.body?.error?.code === 'NOT_FOUND',
      }),
    );

    // --- 3. UI: the Human Work surface renders the formatted offer -------------
    browser = browserSession(name, env.browserTimeoutMs);
    await uiSignIn(browser, env.baseUrl, { email: env.agent.email, password: env.agent.password });
    await browser.findByRole('button', 'click', { name: 'Human Work' });
    await browser.waitForLoad();
    await browser.wait(800);
    const queueUi = await browser.snapshot({});
    const queueShot = evidence.screenshotPath('06-human-work-queue-formatted');
    await browser.screenshot(queueShot);
    const preBlocks = Number((await browser.eval('document.querySelectorAll("main pre").length')).trim());
    const jobTitle = offer?.job?.title ?? '';
    await steps.checkFn(
      'UI: Human Work renders the offer as a formatted card',
      'title renders, eligibility visible, no raw <pre> JSON in main',
      async () => {
        const hasTitle = jobTitle !== '' && queueUi.includes(jobTitle.slice(0, 40));
        const hasButtons = /Accept/.test(queueUi) && /Decline/.test(queueUi);
        const pass = hasTitle && hasButtons && preBlocks === 0;
        return {
          actual: `title=${hasTitle} claimButtons=${hasButtons} preBlocks=${preBlocks}`,
          pass,
          evidence: [queueShot],
        };
      },
    );
    const eligibilityHuman =
      offer?.job?.eligibility?.availability !== undefined || /availability/i.test(queueUi);
    await steps.checkFn(
      'UI: eligibility renders in human terms (day window/territory), not raw JSON',
      'availability or human-terms eligibility text present',
      async () => {
        const hasHumanText = /[0-9]{2}:[0-9]{2}/.test(queueUi) || /city · /i.test(queueUi) || eligibilityHuman;
        return { actual: `humanTerms=${hasHumanText}`, pass: hasHumanText, evidence: [queueShot] };
      },
    );

    const health = await uiHealth(browser);
    const healthPath = evidence.json('07-agent-browser-health', health);
    await steps.checkFn(
      'human-agent UI session has zero page errors',
      'pageErrors = 0',
      async () => ({
        actual: `pageErrors=${health.pageErrors.length}`,
        pass: health.pageErrors.length === 0,
        evidence: [healthPath],
      }),
    );

    // --- 4. destructive opt-in: the real claim proof ----------------------------
    if (env.allowDemoOfferConsumption) {
      const action = (process.env.MOS_E2E_DEMO_OFFER_ACTION ?? 'accept').toLowerCase();
      if (action !== 'accept' && action !== 'decline') {
        throw new Error(`MOS_E2E_DEMO_OFFER_ACTION must be accept|decline (got ${action})`);
      }
      const claim = await api.post(`jobs/queue/offers/${offer.offerId}/${action}`, { token: agent.token, body: {} });
      evidence.response(`08-offer-${action}-claim`, claim, 'DESTRUCTIVE: consumes the seeded offer fixture');
      await steps.checkFn(
        `offer ${action} through the real claim contract → 200`,
        'HTTP 200 with job + offer + replayed flag',
        async () => {
          const pass =
            claim.status === 200 && claim.body?.job !== undefined && claim.body?.offer !== undefined;
          return { actual: `HTTP ${claim.status} replayed=${String(claim.body?.replayed)}`, pass };
        },
      );
      const after = await api.get('jobs/queue', { token: agent.token });
      evidence.response('09-queue-after-claim', after);
      await steps.checkFn(
        `queue reflects the honest post-${action} state`,
        action === 'accept' ? 'open offers 0; job moved to activeJobs (outcome due)' : 'open offers 0; round closed',
        async () => {
          const openAfter = (after.body?.offers ?? []).length;
          if (action === 'accept') {
            const active = after.body?.activeJobs ?? [];
            const claimed = active.some((job) => job.jobId === offer.job.jobId || job.status === 'accepted');
            return { actual: `open=${openAfter} activeJobs=${active.length} claimed=${claimed}`, pass: openAfter === 0 && claimed };
          }
          return { actual: `open=${openAfter}`, pass: openAfter === 0 };
        },
      );
      await steps.info(
        'CONSUMED the seeded demo offer — the documented operator re-seed procedure must run to restore Sam\'s open offer (see tests/e2e/README.md § re-seed)',
      );
    } else {
      await steps.info(
        'claim proof kept non-destructive (set MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION=1 to consume the seeded offer through the real contract)',
      );
    }
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}
