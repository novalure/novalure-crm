import type { MailboxImportedMessage } from "./crm-mailbox";
import type { MailboxMetadata, MailboxSyncDecision } from "./crm-mailbox-sync";

/**
 * A private review hint is not a verified sender, an objection, or permission
 * to send. A mailbox owner must inspect the original source before deciding.
 * In particular, an absence of a hint is never evidence of no objection.
 */
export type MailboxObjectionReview =
  | { state: "review_required"; contactId: string; projectId: string; address: string; senderIdentityVerified: false }
  | { state: "unmatched" | "unavailable"; senderIdentityVerified: false };

export function assessMailboxObjectionReview(input: {
  metadata: MailboxMetadata;
  decision: MailboxSyncDecision;
  message: MailboxImportedMessage | null;
}): MailboxObjectionReview {
  const { metadata, decision, message } = input;
  if (decision.status !== "known" || decision.reason !== "exact_address_unique_contact_unverified_sender" || !decision.contactId || !decision.projectId) {
    return { state: "unmatched", senderIdentityVerified: false };
  }
  const address = metadata.fromAddress?.trim().toLowerCase() ?? "";
  if (!metadata.inInbox || !message || message.senderIdentityVerified !== false ||
      message.providerId !== metadata.providerId || message.fromAddress?.trim().toLowerCase() !== address ||
      !address || address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { state: "unavailable", senderIdentityVerified: false };
  }
  return { state: "review_required", contactId: decision.contactId, projectId: decision.projectId, address, senderIdentityVerified: false };
}
