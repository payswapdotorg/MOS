/**
 * The MVP EMAIL delivery adapter (MKT-068 AC-4/AC-7).
 *
 * The real email channel mechanics — everything except the final
 * provider wire call:
 *
 *   1. RECIPIENT ADDRESS RESOLUTION through the recipient-address
 *      structural port (AC-7): the record's canonical MOS user id is the
 *      ONLY recipient input; the address resolves exclusively from the
 *      canonical /users identity composed with the /agencies membership
 *      authority (the workspace/client context — an ACTIVE member of the
 *      notification's agency). There is NO address field on any input
 *      surface and NO address guessing — an unresolvable recipient is
 *      the honest refused receipt;
 *   2. THE SECRETS-DIMENSION CREDENTIAL GATE in front of every material
 *      resolution (the social-account.credential precedent): operation
 *      `notification.email.credential`, resource = the vault reference
 *      id. Deny/unknown → the honest refused receipt carrying the
 *      decision id — material is never touched;
 *   3. VAULT MATERIAL RESOLUTION through the /credentials
 *      authorized-execution path (READ-ONLY, in-process only — §21; the
 *      material exists only for the transport call and is never
 *      persisted, logged or audited);
 *   4. THE DETERMINISTIC RENDER (subject + body composed from the §14
 *      record facts) and the SEND through the disclosed provider
 *      TRANSPORT SEAM (the EmailTransport port): the deterministic
 *      in-repo test double in tests — NO real network calls — and the
 *      disclosed unwired transport in the production composition until
 *      the provider wiring work item lands a real transport (which will
 *      live under THIS sanctioned adapter subtree and be wired at the
 *      composition root only — no provider SDK import outside it, AC-4).
 *
 * Constructed at the composition root with the public-contract instances
 * + the port + the transport, and registered through the module
 * dependencies as DATA (the adapter-registry precedent).
 */

import { enforcementOutcome } from '../../../../policies/public.ts';
import type { PoliciesModuleApi } from '../../../../policies/public.ts';
import type { CredentialsModuleApi } from '../../../../credentials/public.ts';
import type {
  AdapterDeliveryOutcome,
  AdapterDeliveryRequest,
  ChannelAcceptance,
  EmailTransport,
  NotificationDeliveryAdapter,
  NotificationDeliveryRecord,
  RecipientAddressResolutionPort,
} from '../../../public.ts';
import { NOTIFICATION_EVENT_TYPES } from '../../../public.ts';
import { emailCredentialPolicyOperation } from '../../../internal/delivery-validation.ts';

/** The email channel's declared acceptance: every urgency EXCEPT 'low'. */
export const EMAIL_ACCEPTANCE: ChannelAcceptance = {
  // A deliberate MVP profile: low-urgency events stay in-app only (the
  // email channel carries normal/high/critical) — a real, testable
  // acceptance subset (AC-2: each channel DECLARES what it accepts).
  urgencies: ['normal', 'high', 'critical'],
  eventTypes: [...NOTIFICATION_EVENT_TYPES],
};

export interface EmailDeliveryAdapterDeps {
  /** The /policies public contract (the secrets-dimension credential gate). */
  readonly policies: PoliciesModuleApi;
  /** The /credentials public contract (READ-ONLY material resolution, in-process). */
  readonly credentials: CredentialsModuleApi;
  /** The recipient-address structural port (AC-7 — no address guessing). */
  readonly recipientAddresses: RecipientAddressResolutionPort;
  /** The disclosed provider transport seam (AC-7). */
  readonly transport: EmailTransport;
}

/** The deterministic subject line (bounded, composed from the §14 facts). */
export function renderEmailSubject(record: NotificationDeliveryRecord): string {
  return `[MOS][${record.urgency}] ${record.eventType}`.slice(0, 200);
}

/** The deterministic body (bounded, composed from the §14 facts). */
export function renderEmailBody(record: NotificationDeliveryRecord): string {
  const lines = [
    record.explanation,
    '',
    `Source: ${record.source.kind} ${record.source.id}`,
    record.requiredAction === null ? null : `Required action: ${record.requiredAction}`,
    `Open: ${record.deepLink}`,
    '',
    `Urgency: ${record.urgency} · Event: ${record.eventType}`,
  ].filter((line): line is string => line !== null);
  return lines.join('\n').slice(0, 4000);
}

export class EmailDeliveryAdapter implements NotificationDeliveryAdapter {
  readonly channel = 'email' as const;
  readonly acceptance: ChannelAcceptance = EMAIL_ACCEPTANCE;

  private readonly policies: PoliciesModuleApi;
  private readonly credentials: CredentialsModuleApi;
  private readonly recipientAddresses: RecipientAddressResolutionPort;
  private readonly transport: EmailTransport;

  constructor(deps: EmailDeliveryAdapterDeps) {
    this.policies = deps.policies;
    this.credentials = deps.credentials;
    this.recipientAddresses = deps.recipientAddresses;
    this.transport = deps.transport;
  }

  async deliver(request: AdapterDeliveryRequest): Promise<AdapterDeliveryOutcome> {
    const { notification, provenance } = request;

    // 1. Recipient address resolution — the port is the ONLY path (the
    //    record carries the canonical user id; the address never is).
    if (notification.recipientUserId === null) {
      return {
        outcome: 'refused',
        reason:
          'the email channel requires a recipient user id on the notification record (missing — fail-closed)',
        providerMessageId: null,
      };
    }
    const recipient = await this.recipientAddresses.resolveRecipientAddress({
      userId: notification.recipientUserId,
      agencyId: notification.agencyId,
    });
    if (recipient === null) {
      return {
        outcome: 'refused',
        reason: `recipient user ${notification.recipientUserId} does not resolve to an active member address of the notification's agency (no address guessing — fail-closed)`,
        providerMessageId: null,
      };
    }

    // 2. The secrets-dimension credential gate BEFORE any material
    //    resolution (the social-account.credential precedent).
    if (notification.emailCredentialReferenceId === null) {
      return {
        outcome: 'refused',
        reason:
          'the email channel requires a provider credential vault reference on the notification record (missing — fail-closed)',
        providerMessageId: null,
      };
    }
    const decision = await this.policies.evaluateAction(
      {
        action: {
          dimension: 'secrets',
          operation: emailCredentialPolicyOperation(),
          resource: notification.emailCredentialReferenceId,
          attributes: { channel: 'email' },
        },
        scope: { agencyId: notification.agencyId, clientId: notification.clientId },
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
    if (enforcementOutcome(decision) !== 'allow') {
      return {
        outcome: 'refused',
        reason: `policy denied the email credential use (decision ${decision.decisionId}, reason '${decision.reasonCode}' — material never resolved, fail-closed)`,
        providerMessageId: null,
        policyDecisionId: decision.decisionId,
      };
    }

    // 3. Vault material resolution — authorized-execution scope,
    //    in-process only (§21): the material exists solely for the
    //    transport call below.
    const resolved = await this.credentials.resolveCredentialMaterial({
      credentialId: notification.emailCredentialReferenceId,
      scope: {
        kind: 'authorized-execution',
        agencyId: notification.agencyId,
        clientId: notification.clientId,
      },
    });
    if (resolved === null) {
      return {
        outcome: 'refused',
        reason: `credential reference ${notification.emailCredentialReferenceId} does not resolve in the notification scope (disabled, tombstoned or scope-mismatched — fail-closed)`,
        providerMessageId: null,
      };
    }

    // 4. The deterministic render + the send through the disclosed
    //    provider seam.
    const sent = await this.transport.send({
      to: recipient.address,
      subject: renderEmailSubject(notification),
      body: renderEmailBody(notification),
      credentialMaterial: resolved.material,
    });
    if (sent.outcome === 'sent') {
      return {
        outcome: 'delivered',
        reason: null,
        providerMessageId: sent.providerMessageId,
      };
    }
    return {
      outcome: 'failed',
      reason: sent.reason,
      providerMessageId: sent.providerMessageId,
    };
  }
}
