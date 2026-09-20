/**
 * The EMAIL delivery channel adapter (MKT-068 AC-7 — one of the two MVP
 * DeliveryAdapter implementations), living in the module's sanctioned
 * PROVIDER-SEAM subtree (internal/adapters/ — the only place a provider
 * concern may live; the composition root wires this adapter INTO the
 * module as data, and tests supply the deterministic transport double
 * through the same composition seam).
 *
 * THE PROVIDER SEAM (documented, per AC-7): this adapter contains NO
 * provider SDK and NO network code. All provider interaction rides the
 * EmailTransportPort (declared in the module public entry):
 *
 *   EmailTransportPort.send({ recipients, fromAddress, subject, body,
 *                             credentialMaterial })
 *     → { messageId }
 *
 * A real provider transport (SMTP or a provider API over the platform
 * HTTP port — NO SDK, the OpenRouterAdapter precedent) is FUTURE
 * composition-root wiring: it implements the port, receives the resolved
 * provider credential material in-process, and returns the provider's
 * message id. Until such a transport is wired, the composition root
 * constructs NO email adapter (the channel is simply absent — the
 * fail-closed socialAccountFlows precedent); the integration tests
 * supply the DETERMINISTIC IN-REPO test double (no network calls).
 *
 * RECIPIENT RESOLUTION (AC-7 — from the workspace/client context only,
 * no address guessing): the adapter resolves the recipient set through
 * the NotificationRecipientResolutionPort — the operator context of the
 * notification's own scope chain (the agency owning the client). The
 * PURE selection policy (selectNotificationRecipients, exported from
 * the module public entry for unit pinning): the ACTIVE agency_owner
 * members with active user identities — deduped, sorted, bounded. NO
 * email address is EVER taken from a request body, composed from a
 * domain, or guessed: when nothing resolves, the delivery FAILS
 * HONESTLY (a failed receipt with the bounded reason — never a silent
 * drop, never an invented recipient).
 *
 * PROVIDER CREDENTIALS (AC-4 — the /credentials vault, READ-ONLY): the
 * adapter carries the vault REFERENCE id of the provider credential
 * (supplied at construction — explicit deployment configuration, never
 * a module-table value) and resolves the material at delivery time
 * through the NotificationEmailCredentialPort (the narrow structural
 * view of the /credentials vault) in the notification's OWN
 * authorized-execution scope. The material exists ONLY in-process for
 * the transport call — never persisted, logged, receipted or audited
 * (there is no material-shaped column anywhere in migration 047).
 *
 * The MVP provider-credential scope disclosure: vault references are
 * agency-scoped, so a deployment serves email through the references it
 * configured (the composition seam carries the explicit reference id);
 * a notification whose agency has no resolvable reference fails the
 * email channel HONESTLY (the failed receipt names the unresolvable
 * credential) while the in-app channel still delivers. Per-agency
 * credential mapping is notification-policy/console territory (a later
 * Work Item), never silently invented here.
 */

import type {
  AdapterDeliveryInput,
  AdapterDeliveryOutcome,
  EmailTransportPort,
  NotificationDeliveryAdapter,
  NotificationEmailCredentialPort,
  NotificationEventType,
  NotificationRecipientResolutionPort,
  NotificationUrgency,
} from '../../public.ts';
import {
  composeNotificationEmailEnvelope,
  selectNotificationRecipients,
} from '../../public.ts';

/** The email adapter construction configuration (all explicit wiring). */
export interface EmailNotificationAdapterConfig {
  /** The deterministic provider seam (a real transport is future wiring). */
  readonly transport: EmailTransportPort;
  /**
   * The recipient-resolution port (the operator context of the
   * notification's owning agency — satisfied at the composition root
   * from the /agencies membership + /users identity authorities).
   */
  readonly recipientResolution: NotificationRecipientResolutionPort;
  /** The /credentials vault view (READ-ONLY — material resolution by reference). */
  readonly credentials: NotificationEmailCredentialPort;
  /** The vault REFERENCE id of the provider credential (explicit deployment configuration). */
  readonly credentialReferenceId: string;
  /** The verified sender address of the provider configuration. */
  readonly fromAddress: string;
}

/**
 * Creates the email DeliveryAdapter. The channel accepts the three
 * operator-facing urgencies (important, urgent, critical) and every
 * event type — routine notices stay in the in-app inbox (the declared
 * MVP subset; broadening is /policies-or-console territory, never
 * silent).
 */
export function createEmailNotificationAdapter(
  config: EmailNotificationAdapterConfig,
): NotificationDeliveryAdapter {
  const acceptedUrgencies: readonly NotificationUrgency[] = [
    'important',
    'urgent',
    'critical',
  ];
  const acceptedEventTypes: readonly NotificationEventType[] | null = null;

  return {
    channel: 'email',
    acceptedUrgencies,
    acceptedEventTypes,
    accepts: ({ urgency }) => acceptedUrgencies.includes(urgency),
    deliver: async (input: AdapterDeliveryInput): Promise<AdapterDeliveryOutcome> => {
      const notification = input.notification;

      // 1. RECIPIENT RESOLUTION — from the workspace/client context only
      //    (the owning agency's operator context; never a request field,
      //    never guessed). No resolvable recipient → the honest failure.
      const candidates = await config.recipientResolution.resolveRecipientCandidates(
        notification.agencyId,
      );
      const recipients = selectNotificationRecipients(candidates);
      if (recipients.length === 0) {
        return {
          outcome: 'failed',
          reason:
            'no resolvable email recipient in the workspace/client context (no active agency owner with an active identity) — never guessed',
        };
      }

      // 2. PROVIDER CREDENTIAL RESOLUTION — the vault reference in the
      //    notification's own authorized-execution scope (READ-ONLY; the
      //    material exists only in-process for the transport call).
      const resolved = await config.credentials.resolveCredentialMaterial({
        credentialId: config.credentialReferenceId,
        scope: {
          kind: 'authorized-execution',
          agencyId: notification.agencyId,
          clientId: notification.clientId,
        },
      });
      if (resolved === null) {
        return {
          outcome: 'failed',
          reason:
            `the provider credential reference does not resolve in this notification's scope (vault reference '${config.credentialReferenceId}' — disabled, tombstoned or scope-mismatched) — email fails closed`,
        };
      }

      // 3. THE TRANSPORT CALL — the documented provider seam. The
      //    envelope is the pure §14 composition; the material passes
      //    in-process ONLY.
      const envelope = composeNotificationEmailEnvelope(notification);
      const sent = await config.transport.send({
        recipients: [...recipients],
        fromAddress: config.fromAddress,
        subject: envelope.subject,
        body: envelope.body,
        credentialMaterial: resolved.material,
      });

      return { outcome: 'delivered', providerMessageId: sent.messageId };
    },
  };
}
