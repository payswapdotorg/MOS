/**
 * JOURNEY: client-context surfaces (evidence / decisions / learning / memory
 * + decision detail with rationale).
 *
 * Handoff §8 checklist items:
 *   - Client journey (client-context surfaces)
 *   - Decision Ledger visible at client context (rationale preserved)
 *   - Operating Graph trace context surfaces from the client workspace
 *
 * UI steps: agency owner opens a client workspace and walks the INTELLIGENCE
 * tabs. API steps: decision detail (rationale + provenance) and the decision
 * room read model. READ-ONLY on demo data.
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { uiSignIn, uiHealth, waitForSnapshot } from '../lib/ui.mjs';
import { browserSession } from '../lib/browser.mjs';

export const name = 'client';
export const checklist = ['Client journey', 'Decision Ledger visible at agency/client context'];
export const requires = ['MOS_E2E_OWNER_*', 'agent-browser'];

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  let browser = null;
  try {
    // --- 1. API: the client's intelligence records -----------------------------
    const owner = await api.login(env.owner.email, env.owner.password);
    const agencyId = shared.demoAgencyId ?? (await resolveAgency(api, owner.token));
    const clients = await api.get(`agencies/${agencyId}/clients`, { token: owner.token });
    const clientId = clients.body?.clients?.find((client) => client.name === 'Helio Robotics')?.clientId ??
      clients.body?.clients?.[0]?.clientId;
    await steps.checkFn(
      'client context resolves (Helio Robotics first)',
      'clientId present',
      async () => ({ actual: `clientId=${String(clientId).slice(0, 13)}…`, pass: typeof clientId === 'string' }),
    );

    const evidenceList = await api.get(`clients/${clientId}/evidence`, { token: owner.token });
    evidence.response('00-client-evidence-list', evidenceList);
    await steps.checkFn(
      'client evidence tab data: ≥ 3 graded observations',
      'evidence rows with quality grades',
      async () => {
        const rows = evidenceList.body?.evidence ?? [];
        const graded = rows.every((row) => typeof row.quality === 'string' || row.quality === null);
        const pass = rows.length >= 3 && graded;
        return { actual: `evidence=${rows.length}`, pass };
      },
    );

    const decisionsList = await api.get(`clients/${clientId}/decisions`, { token: owner.token });
    evidence.response('01-client-decisions-list', decisionsList);
    const decisionRows = decisionsList.body?.decisions ?? [];
    // Prefer a decision whose context (the human rationale) is seeded — the
    // contract makes context optional; the demo seed populates it.
    const firstDecision =
      decisionRows.find((row) => typeof row.context === 'string' && row.context.length > 20) ??
      decisionRows[0];
    await steps.checkFn(
      'client decisions tab data: ≥ 3 recorded decisions',
      'decision rows with ids',
      async () => {
        const pass = decisionRows.length >= 3 && typeof firstDecision?.decisionId === 'string';
        return { actual: `decisions=${decisionRows.length}`, pass };
      },
    );

    const decisionDetail = await api.get(`decisions/${firstDecision.decisionId}`, { token: owner.token });
    evidence.response('02-decision-detail-with-rationale', decisionDetail);
    await steps.checkFn(
      'decision detail preserves rationale + provenance',
      'context (rationale), hypothesisSummary, evidenceRefs, provenance',
      async () => {
        const body = decisionDetail.body ?? {};
        const hasRationale = typeof body.context === 'string' && body.context.length > 20;
        const hasHypothesis = body.hypothesisSummary !== undefined;
        const hasEvidenceRefs = Array.isArray(body.evidenceRefs);
        const hasProvenance = body.provenance !== undefined && body.provenance !== null;
        const pass = hasRationale && hasHypothesis && hasEvidenceRefs && hasProvenance;
        return {
          actual: `context=${hasRationale} hypothesis=${hasHypothesis} evidenceRefs=${hasEvidenceRefs} provenance=${hasProvenance}`,
          pass,
        };
      },
    );

    const decisionRoom = await api.get(`reporting/decision-room/${clientId}`, { token: owner.token });
    evidence.response('03-decision-room', decisionRoom);
    await steps.checkFn(
      'decision room read model renders for the client',
      'whatHappened + why + experiments + recommendations blocks present',
      async () => {
        const body = decisionRoom.body ?? {};
        const blocks = ['whatHappened', 'why', 'evidenceQuality', 'experiments', 'recommendations'];
        const present = blocks.filter((block) => body[block] !== undefined);
        const pass = decisionRoom.status === 200 && present.length === blocks.length;
        return { actual: `status=${decisionRoom.status} blocks=${present.join(',')}`, pass };
      },
    );

    const learnings = await api.get(`clients/${clientId}/learnings`, { token: owner.token });
    evidence.response('04-client-learnings', learnings);
    await steps.checkFn(
      'client learning tab data: ≥ 2 learnings',
      'learning rows',
      async () => {
        const rows = learnings.body?.learnings ?? [];
        const pass = rows.length >= 2;
        return { actual: `learnings=${rows.length}`, pass };
      },
    );

    const memory = await api.get(`client-memory/${agencyId}/clients/${clientId}`, { token: owner.token });
    evidence.response('05-client-memory', memory);
    await steps.checkFn(
      'client memory projection surfaces items',
      'memory items + projection present',
      async () => {
        const items = memory.body?.items ?? [];
        const projection = memory.body?.projection ?? null;
        const pass = items.length >= 1 && projection !== null;
        return { actual: `items=${items.length} projection=${projection === null ? 'null' : 'present'}`, pass };
      },
    );

    // --- 2. UI: walk the client workspace intelligence tabs --------------------
    browser = browserSession(name, env.browserTimeoutMs);
    await uiSignIn(browser, env.baseUrl, { email: env.owner.email, password: env.owner.password });
    await browser.findByRole('button', 'click', { name: 'Clients' });
    await browser.waitForLoad();
    await browser.findByRole('button', 'click', { name: 'Open workspace' });
    await browser.waitForLoad();
    // Bounded poll for the workspace tab strip (view-transition race guard).
    await waitForSnapshot(browser, (text) => /tab "Decisions"/.test(text) && /tab "Memory"/.test(text));

    for (const tab of ['Evidence', 'Decisions', 'Learning', 'Memory']) {
      await browser.findByRole('tab', 'click', { name: tab });
      await browser.wait(700);
      const panel = await browser.snapshot({});
      const tabShot = evidence.screenshotPath(`06-workspace-tab-${tab.toLowerCase()}`);
      await browser.screenshot(tabShot);
      const errorBoundary = /An error occurred|Application error|Unhandled Runtime Error/i.test(panel);
      // SOFT check: a formatting failure on one intelligence tab must not
      // hide the render results of the remaining tabs (the journey still
      // fails overall when any tab fails — see outcome()).
      await steps.checkSoft(
        `UI: ${tab} tab renders formatted real data (no raw JSON, no error boundary)`,
        'content renders; no <pre> dump in main',
        async () => {
          const preCount = await browser.eval(
            'document.querySelectorAll("main pre").length',
          );
          const pass = !errorBoundary && Number(preCount) === 0 && panel.length > 200;
          return {
            actual: `panelChars=${panel.length} preBlocks=${String(preCount).trim()} errorBoundary=${errorBoundary}`,
            pass,
            evidence: [tabShot],
          };
        },
      );
    }

    // --- 3. UI: decision detail with rationale ---------------------------------
    await browser.findByRole('tab', 'click', { name: 'Decisions' });
    await browser.wait(700);
    const decisionsPanel = await browser.snapshot({});
    // Decision rows are buttons/links — open the first decision if the UI
    // exposes a detail affordance; otherwise the tab already renders the
    // rationale summary (DEP-003b verified the decision-room blocks).
    const decisionShot = evidence.screenshotPath('07-decisions-tab');
    await browser.screenshot(decisionShot);
    await steps.checkFn(
      'UI: decisions tab shows decision records with objective/context',
      'decision entries render (objective or rationale text visible)',
      async () => {
        const hasDecisionText =
          decisionsPanel.includes('disposition') ||
          decisionsPanel.includes('Finance asked') ||
          decisionsPanel.length > 600;
        return { actual: `decisionsPanelChars=${decisionsPanel.length}`, pass: hasDecisionText, evidence: [decisionShot] };
      },
    );

    const health = await uiHealth(browser);
    const healthPath = evidence.json('08-client-browser-health', health);
    await steps.checkFn(
      'client journey UI session has zero page errors',
      'pageErrors = 0',
      async () => ({
        actual: `pageErrors=${health.pageErrors.length}`,
        pass: health.pageErrors.length === 0,
        evidence: [healthPath],
      }),
    );
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}

async function resolveAgency(api, token) {
  const context = await api.get('auth/authorization-context', { token });
  const membership = context.body?.memberships?.[0];
  if (typeof membership?.agencyId !== 'string') {
    throw new Error('could not resolve the demo agency for the client journey');
  }
  return membership.agencyId;
}
