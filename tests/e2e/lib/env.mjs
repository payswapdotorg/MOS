/**
 * E2E harness environment contract (VER-001).
 *
 * Target selection:      MOS_E2E_BASE_URL (default: the production console)
 * Persona credentials:   MOS_E2E_{OWNER,OPERATOR,AGENT}_{EMAIL,PASSWORD}
 * Throwaway account:     MOS_E2E_THROWAWAY_{EMAIL,PASSWORD,AGENCY_NAME}
 *                        (unset ⇒ generated in-memory, never printed/stored)
 * Destructive opt-in:    MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION=1
 * Run label:             MOS_E2E_RUN_ID
 * UI degradation:        MOS_E2E_SKIP_UI=1 (API-only smoke — recorded as deviation)
 *
 * RULES (see tests/e2e/README.md):
 * - No credential value is ever written to a file or logged by this harness.
 * - Only Node (>= 18, stdlib fetch) + the agent-browser CLI are required.
 */

import { randomBytes } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://mos-product.vercel.app';

const SENSITIVE_KEY_PATTERN = /token|password|secret|authorization|credential|bearer/i;

function optional(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function requirePair(prefix, label) {
  const email = optional(`MOS_E2E_${prefix}_EMAIL`);
  const password = optional(`MOS_E2E_${prefix}_PASSWORD`);
  if (email === undefined || password === undefined) {
    throw new Error(
      `Missing demo persona credentials for the ${label} journey: set MOS_E2E_${prefix}_EMAIL and MOS_E2E_${prefix}_PASSWORD (the seeded demo personas are displayed on the console login screen's "Demo accounts" panel).`,
    );
  }
  return { email, password };
}

/** A fresh throwaway identity (`.example` — never `.demo`, the demo badge heuristic). */
function generateThrowaway() {
  const suffix = randomBytes(5).toString('hex');
  return {
    email: `mos-e2e-${suffix}@ver-e2e.example`,
    // 24 chars, charset-safe, satisfies the 12–256 signup rule.
    password: `E2e-${randomBytes(9).toString('base64url')}-x`,
    agencyName: `E2E Verification ${suffix}`,
    displayName: `MOS E2E ${suffix}`,
    generated: true,
  };
}

export function resolveEnv() {
  const baseUrl = (optional('MOS_E2E_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const runId =
    optional('MOS_E2E_RUN_ID') ??
    `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 17)}`;
  const browserTimeoutMs = Number(optional('MOS_E2E_BROWSER_TIMEOUT_MS') ?? 60000);

  const env = {
    baseUrl,
    runId,
    browserTimeoutMs,
    owner: undefined,
    operator: undefined,
    agent: undefined,
    throwaway: undefined,
    allowDemoOfferConsumption: optional('MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION') === '1',
    skipUi: optional('MOS_E2E_SKIP_UI') === '1',
  };

  const ownerEmail = optional('MOS_E2E_OWNER_EMAIL');
  if (ownerEmail !== undefined) {
    env.owner = requirePair('OWNER', 'owner/operator');
  }
  const operatorEmail = optional('MOS_E2E_OPERATOR_EMAIL');
  if (operatorEmail !== undefined) {
    env.operator = requirePair('OPERATOR', 'owner/operator');
  }
  const agentEmail = optional('MOS_E2E_AGENT_EMAIL');
  if (agentEmail !== undefined) {
    env.agent = requirePair('AGENT', 'human-agent');
  }

  const throwawayEmail = optional('MOS_E2E_THROWAWAY_EMAIL');
  if (throwawayEmail !== undefined) {
    const password = optional('MOS_E2E_THROWAWAY_PASSWORD');
    if (password === undefined) {
      throw new Error('MOS_E2E_THROWAWAY_EMAIL set without MOS_E2E_THROWAWAY_PASSWORD.');
    }
    env.throwaway = {
      email: throwawayEmail,
      password,
      agencyName: optional('MOS_E2E_THROWAWAY_AGENCY_NAME') ?? 'E2E Throwaway Agency',
      displayName: optional('MOS_E2E_THROWAWAY_DISPLAY_NAME') ?? 'MOS E2E Throwaway',
      generated: false,
    };
  } else {
    env.throwaway = generateThrowaway();
  }

  return env;
}

/** Describe the env for logs WITHOUT any credential value. */
export function describeEnv(env) {
  const mask = (creds) =>
    creds === undefined ? 'unset' : `${creds.email.replace(/^(.).*(@.*)$/, '$1***$2')}/***`;
  return {
    baseUrl: env.baseUrl,
    runId: env.runId,
    owner: mask(env.owner),
    operator: mask(env.operator),
    agent: mask(env.agent),
    throwaway: env.throwaway.generated
      ? 'generated-in-memory (.example domain)'
      : `provided (${mask(env.throwaway)})`,
    allowDemoOfferConsumption: env.allowDemoOfferConsumption,
    skipUi: env.skipUi,
    browserTimeoutMs: env.browserTimeoutMs,
  };
}

export { SENSITIVE_KEY_PATTERN };
