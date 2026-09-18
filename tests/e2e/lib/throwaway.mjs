/**
 * E2E throwaway-tenant helpers (VER-001).
 *
 * The throwaway identity is a REAL account created through the real sign-up
 * contract (`.example` email — never `.demo`, which is the demo badge
 * heuristic). Credentials are generated IN-MEMORY when not provided via env
 * and are never printed, logged or written to evidence (redaction is a second
 * layer; the primary rule is that the values simply never reach a file).
 *
 * One signup per run: the first journey that needs the tenant creates it and
 * marks shared.throwaway.signedUp — later journeys reuse the identity and
 * open their own fresh sessions (each journey logs in itself).
 */

import { firstAgencyId } from './http.mjs';

/**
 * Ensure the shared throwaway exists (signing up at most once per run) and
 * return the identity record. Session tokens are per-journey: use loginThrowaway().
 */
export async function ensureThrowaway(shared, api, evidence, steps) {
  const throwaway = shared.throwaway;
  if (throwaway.signedUp) {
    await steps.info('throwaway identity reused from earlier journey');
    return throwaway;
  }
  if (throwaway.generated) {
    const signup = await api.signup({
      displayName: throwaway.displayName,
      email: throwaway.email,
      agencyName: throwaway.agencyName,
      password: throwaway.password,
    });
    evidence.response('throwaway-signup', signup, 'real zero-simulation account (.example domain)');
    if (signup.status !== 201) {
      throw new Error(`throwaway sign-up failed: HTTP ${signup.status}`);
    }
  } else {
    await steps.info('throwaway account provided via environment (assumed fresh)');
  }
  throwaway.signedUp = true;
  return throwaway;
}

/** Open the throwaway's own session and resolve its agency id. */
export async function loginThrowaway(shared, api) {
  const throwaway = shared.throwaway;
  const login = await api.login(throwaway.email, throwaway.password);
  const context = await api.get('auth/authorization-context', { token: login.token });
  const agencyId = firstAgencyId(context.body);
  if (typeof agencyId !== 'string') {
    throw new Error('throwaway authorization-context has no agency membership');
  }
  throwaway.userId = login.userId;
  throwaway.agencyId = agencyId;
  throwaway.memberships = context.body?.memberships ?? [];
  return { token: login.token, agencyId, context };
}

/**
 * Ensure the throwaway tenant has a client (created through the real contract)
 * and return { clientId, created }.
 *
 * Cross-process safe: when a journey runs standalone (`--journey=…`) with an
 * env-provided throwaway, the shared in-memory clientId is gone — so an
 * existing client of the throwaway agency is discovered and reused BEFORE
 * creating a new one (a second client would break the single-client UI
 * auto-selection in the Apps screen and duplicate tenant state).
 */
export async function ensureThrowawayClient(shared, api, evidence, steps, clientName) {
  const { token, agencyId } = await loginThrowaway(shared, api);
  if (shared.throwaway.clientId !== undefined) {
    const read = await api.get(`clients/${shared.throwaway.clientId}`, { token });
    if (read.status === 200) {
      await steps.info(`throwaway client reused from earlier journey (${shared.throwaway.clientId})`);
      return { clientId: shared.throwaway.clientId, created: false, token, agencyId };
    }
  }
  const existing = await api.get(`agencies/${agencyId}/clients`, { token });
  const firstExisting = existing.body?.clients?.[0];
  if (firstExisting !== undefined) {
    shared.throwaway.clientId = firstExisting.clientId;
    await steps.info(
      `throwaway client discovered on the tenant (${firstExisting.name}) — reusing instead of creating a second one`,
    );
    return { clientId: firstExisting.clientId, created: false, token, agencyId };
  }
  const create = await api.post(`agencies/${agencyId}/clients`, { token, body: { name: clientName } });
  evidence.response('throwaway-create-client', create);
  if (create.status !== 201 || typeof create.body?.clientId !== 'string') {
    throw new Error(`throwaway client creation failed: HTTP ${create.status}`);
  }
  shared.throwaway.clientId = create.body.clientId;
  return { clientId: create.body.clientId, created: true, token, agencyId };
}
