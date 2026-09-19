/**
 * MKT-055 integration-test harness — the LOCAL OAUTH PROVIDER DOUBLE.
 *
 * A disclosed TEST DOUBLE AT THE PROVIDER BOUNDARY ONLY (the dispatch
 * acceptance: "integration tests use a LOCAL provider double served from
 * the test process — the connection model under test is fully real;
 * adapters are MKT-056+ scope"):
 *
 *   - an in-process loopback HTTP server standing in for the provider
 *     (NO external network, NO real platform OAuth endpoints — not
 *     callable from the sandbox and deliberately not attempted): the
 *     provider-neutral OAuth token endpoint (code exchange + refresh),
 *     the revocation endpoint, the integration probe endpoint the real
 *     first-party CRM connector pings, and the resource-owner fixture
 *     endpoint that mints authorization codes bound to external account
 *     identities, verbatim scope lists and capability tags;
 *   - the FLOW IMPLEMENTATION of the provider-neutral
 *     SocialAccountFlowImplementation port (the contract the MKT-056+
 *     adapter layer will implement per platform): it performs REAL HTTP
 *     round-trips against the local server via fetch, provisions the
 *     token material into the fs secret backend under an OPAQUE handle
 *     (the deployment-level provisioning path the production adapter
 *     host would own) and returns the exchange outcome — the module
 *     under test is the fully real connection model.
 *
 * Scriptable behaviors (the fail-closed batteries):
 *   - 'ok' (default): exchanges succeed;
 *   - 'reject-code': the token endpoint answers 400 invalid_grant (the
 *     flow implementation throws — the round stays pending, zero rows);
 *   - 'garbage': the token endpoint answers a non-JSON body;
 *   - `skipHandleProvisioning`: the flow implementation returns a handle
 *     it did NOT provision — the module's credential-vault reference
 *     integrity battery (a dangling handle is rejected, zero rows).
 *
 * Token materials are FAKE sandbox strings ASSEMBLED AT RUNTIME (the §21
 * posture: they exist only in the secrets-dir files and in-process).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SocialAccountFlowCallContext,
  SocialAccountFlowExchangeOutcome,
  SocialAccountFlowImplementation,
} from '../../../src/modules/social-accounts/public.ts';

export type LocalOAuthMode = 'ok' | 'reject-code' | 'garbage';

export interface IssuedAuthorization {
  readonly code: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
}

export interface LocalOAuthProvider {
  readonly url: string;
  readonly port: number;
  /** The number of token-endpoint exchanges received (code + refresh). */
  exchangeCount(): number;
  /** The number of revocation-endpoint calls received. */
  revokeCount(): number;
  /** Sets the failure mode served by the token endpoint. */
  setMode(mode: LocalOAuthMode): void;
  /**
   * When true, the flow implementation returns a handle it did NOT
   * provision (the dangling-handle battery).
   */
  skipHandleProvisioning: boolean;
  /**
   * The resource-owner fixture: mints an authorization code bound to an
   * external account identity, a VERBATIM scope list and capability tags.
   */
  issueAuthorization(input: {
    readonly accountId: string;
    readonly displayIdentity: string;
    readonly verifiedAt: string | null;
    readonly scopes: readonly string[];
    readonly capabilityTags: readonly string[];
    /** The token expiry served on exchange (null = no expiry reported). */
    readonly expiresInMs: number | null;
    /** The scope list served on REFRESH (defaults to the issued list). */
    readonly refreshScopes?: readonly string[];
    /** The token expiry served on REFRESH (defaults to the issued expiry). */
    readonly refreshExpiresInMs?: number | null;
  }): IssuedAuthorization;
  close(): Promise<void>;
}

interface AuthorizationFixture {
  readonly accountId: string;
  readonly displayIdentity: string;
  readonly verifiedAt: string | null;
  readonly scopes: readonly string[];
  readonly refreshScopes: readonly string[];
  readonly capabilityTags: readonly string[];
  readonly expiresInMs: number | null;
  readonly refreshExpiresInMs: number | null;
  readonly authorizationCode: string;
  readonly refreshToken: string;
}

/** Boots the LOCAL provider double (loopback HTTP server). */
export function startLocalOAuthProvider(): Promise<LocalOAuthProvider> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // The integration connect-probe endpoint (the real first-party CRM
      // connector pings GET /v1/ping with the bearer credential).
      if (req.method === 'GET' && url.pathname === '/v1/ping') {
        reply(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        exchanges += 1;
        if (mode === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('<html>not json</html>');
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          reply(400, { error: 'invalid_request' });
          return;
        }
        if (mode === 'reject-code') {
          reply(400, { error: 'invalid_grant' });
          return;
        }
        const grantType = parsed['grant_type'];
        let fixture: AuthorizationFixture | undefined;
        if (grantType === 'authorization_code') {
          fixture = authorizations.get(String(parsed['code'] ?? ''));
          // Authorization codes are SINGLE-USE (the OAuth discipline).
          if (fixture !== undefined) authorizations.delete(String(parsed['code']));
        } else if (grantType === 'refresh_token') {
          fixture = refreshTokens.get(String(parsed['refresh_token'] ?? ''));
        }
        if (fixture === undefined) {
          reply(400, { error: 'invalid_grant' });
          return;
        }
        const accessToken = `sandbox-at-${randomUUID()}`;
        const refreshToken = `sandbox-rt-${randomUUID()}`;
        const fresh: AuthorizationFixture = { ...fixture, refreshToken };
        refreshTokens.set(refreshToken, fresh);
        reply(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          scope: (grantType === 'refresh_token' ? fixture.refreshScopes : fixture.scopes).join(' '),
          account_id: fixture.accountId,
          display_name: fixture.displayIdentity,
          verified_at: fixture.verifiedAt,
          expires_in_ms:
            grantType === 'refresh_token' ? fixture.refreshExpiresInMs : fixture.expiresInMs,
          capabilities: [...fixture.capabilityTags],
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
        revokes += 1;
        reply(200, { revoked: true });
        return;
      }

      reply(404, { error: 'not_found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        url,
        port: address.port,
        exchangeCount: () => exchanges,
        revokeCount: () => revokes,
        setMode: (next: LocalOAuthMode) => {
          mode = next;
        },
        skipHandleProvisioning: false,
        issueAuthorization(input) {
          const authorizationCode = `sandbox-code-${randomUUID()}`;
          const refreshToken = `sandbox-rt-${randomUUID()}`;
          const fixture: AuthorizationFixture = {
            accountId: input.accountId,
            displayIdentity: input.displayIdentity,
            verifiedAt: input.verifiedAt,
            scopes: [...input.scopes],
            refreshScopes: [...(input.refreshScopes ?? input.scopes)],
            capabilityTags: [...input.capabilityTags],
            expiresInMs: input.expiresInMs,
            refreshExpiresInMs:
              input.refreshExpiresInMs === undefined ? input.expiresInMs : input.refreshExpiresInMs,
            authorizationCode,
            refreshToken,
          };
          authorizations.set(authorizationCode, fixture);
          refreshTokens.set(refreshToken, fixture);
          return { code: authorizationCode, accountId: input.accountId, scopes: [...input.scopes] };
        },
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)));
          }),
      });
    });
  });
}

/**
 * The FLOW IMPLEMENTATION of the provider-neutral port (the MKT-056+
 * adapter contract seed): real HTTP round-trips against the local
 * provider double, token provisioning into the fs secret backend under
 * an opaque handle, and the exchange outcome mapping (the VERBATIM scope
 * list from the provider's space-separated scope response + the
 * capability tags + the identity facts + the reported expiry).
 */
export function createLocalOAuthFlow(
  provider: LocalOAuthProvider,
  options: {
    readonly adapterKey: string;
    readonly secretsDir: string;
  },
): SocialAccountFlowImplementation {
  let provisioned = 0;

  /** Provisions the token bundle into the fs secret backend; returns the opaque handle. */
  function provisionTokenBundle(accessToken: string, refreshToken: string): string {
    provisioned += 1;
    const handle = `sa-oauth-${options.adapterKey}-${provisioned}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(
      path.join(options.secretsDir, `${handle}.secret`),
      JSON.stringify({ accessToken, refreshToken }),
      { mode: 0o600 },
    );
    return handle;
  }

  async function tokenEndpoint(body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(`${provider.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`the provider token endpoint rejected the exchange (HTTP ${response.status})`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new Error(
        `the provider token endpoint returned a non-JSON body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('the provider token endpoint returned a malformed body');
    }
    return parsed as Record<string, unknown>;
  }

  function outcomeOf(payload: Record<string, unknown>): SocialAccountFlowExchangeOutcome {
    const accessToken = String(payload['access_token'] ?? '');
    const refreshToken = String(payload['refresh_token'] ?? '');
    const scopeText = String(payload['scope'] ?? '');
    const expiresInMs = payload['expires_in_ms'];
    const expiresAt =
      expiresInMs === null || expiresInMs === undefined || typeof expiresInMs !== 'number'
        ? null
        : new Date(Date.now() + expiresInMs).toISOString();
    const handle = provider.skipHandleProvisioning
      ? `sa-oauth-dangling-${randomUUID().slice(0, 8)}`
      : provisionTokenBundle(accessToken, refreshToken);
    return {
      identity: {
        externalAccountId: String(payload['account_id'] ?? ''),
        displayIdentity: String(payload['display_name'] ?? ''),
        verifiedAt:
          payload['verified_at'] === null || payload['verified_at'] === undefined
            ? null
            : String(payload['verified_at']),
      },
      grantedScopes: scopeText === '' ? [] : scopeText.split(' '),
      capabilityTags: Array.isArray(payload['capabilities'])
        ? (payload['capabilities'] as unknown[]).map((tag) => String(tag))
        : [],
      tokenSecretHandle: handle,
      expiresAt,
    };
  }

  return {
    descriptor: {
      adapterKey: options.adapterKey,
      flowLabel: `Local OAuth flow ${options.adapterKey}`,
      description:
        'The disclosed integration-test provider double of the provider-neutral flow port - served from the test process; the connection model under test is fully real.',
    },
    async buildAuthorizeUrl(
      _context: SocialAccountFlowCallContext,
      input: { readonly state: string; readonly requestedScopes: readonly string[] | null },
    ): Promise<{ readonly authorizeUrl: string }> {
      const scope = input.requestedScopes === null ? '' : `&scope=${encodeURIComponent(input.requestedScopes.join(' '))}`;
      return {
        authorizeUrl: `${provider.url}/oauth/authorize?state=${encodeURIComponent(input.state)}${scope}`,
      };
    },
    async exchangeAuthorizationCode(
      _context: SocialAccountFlowCallContext,
      input: { readonly code: string; readonly state: string },
    ): Promise<SocialAccountFlowExchangeOutcome> {
      void input.state;
      const payload = await tokenEndpoint({
        grant_type: 'authorization_code',
        code: input.code,
      });
      return outcomeOf(payload);
    },
    async refreshAuthorization(
      _context: SocialAccountFlowCallContext,
      input: { readonly currentTokenMaterial: Uint8Array },
    ): Promise<SocialAccountFlowExchangeOutcome> {
      let refreshToken = '';
      try {
        const bundle = JSON.parse(new TextDecoder().decode(input.currentTokenMaterial)) as {
          refreshToken?: unknown;
        };
        refreshToken = typeof bundle.refreshToken === 'string' ? bundle.refreshToken : '';
      } catch {
        refreshToken = '';
      }
      const payload = await tokenEndpoint({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return outcomeOf(payload);
    },
    async revokeAuthorization(
      _context: SocialAccountFlowCallContext,
      input: { readonly currentTokenMaterial: Uint8Array },
    ): Promise<{ readonly revoked: boolean; readonly message: string | null }> {
      let accessToken = '';
      try {
        const bundle = JSON.parse(new TextDecoder().decode(input.currentTokenMaterial)) as {
          accessToken?: unknown;
        };
        accessToken = typeof bundle.accessToken === 'string' ? bundle.accessToken : '';
      } catch {
        accessToken = '';
      }
      const response = await fetch(`${provider.url}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: accessToken }),
      });
      return {
        revoked: response.ok,
        message: response.ok ? null : `the provider revoke endpoint answered HTTP ${response.status}`,
      };
    },
  };
}
