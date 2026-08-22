export const botWebhookLeaseSeconds = 120;
export const botWebhookMaxEventsPerBatch = 10;
export const botWebhookMaxProcessingAttempts = 5;
export const botWebhookRateWindowMinutes = 5;
export const botWebhookAccountEventLimit = 120;
export const botWebhookContactEventLimit = 12;

export const botWebhookTerminalStates = ["completed", "ignored"] as const;
export const botWebhookReplyStates = [
  "not_requested",
  "attempting",
  "completed",
  "blocked",
  "not_applicable",
  "uncertain",
] as const;

export type BotWebhookReplyState = (typeof botWebhookReplyStates)[number];
export type BotWebhookClaimOutcome =
  | "claimed"
  | "completed"
  | "ignored"
  | "in_flight"
  | "payload_conflict";

export type BotWebhookReplyAction = "attempt" | "done" | "hold";
export type BotWebhookMappingStatus = "ambiguous" | "matched" | "not_found" | "unavailable" | "unsupported";
export type BotWebhookBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: "account_rate_limit" | "contact_rate_limit" };

/**
 * A missing/unsupported target is a deliberate terminal ignore. Ambiguous or
 * temporarily unavailable mapping must stay retryable because acknowledging it
 * would permanently discard an otherwise valid provider event.
 */
export function getBotWebhookMappingHttpStatus(status: BotWebhookMappingStatus): 200 | 503 | null {
  if (status === "matched") return null;
  if (status === "ambiguous" || status === "unavailable") return 503;
  return 200;
}

export function evaluateBotWebhookBudget(input: {
  accountEventCount: number;
  contactEventCount: number;
}): BotWebhookBudgetDecision {
  if (input.accountEventCount > botWebhookAccountEventLimit) {
    return { allowed: false, reason: "account_rate_limit" };
  }
  if (input.contactEventCount > botWebhookContactEventLimit) {
    return { allowed: false, reason: "contact_rate_limit" };
  }
  return { allowed: true };
}

export function isBotWebhookReplyState(value: unknown): value is BotWebhookReplyState {
  return typeof value === "string" && botWebhookReplyStates.includes(value as BotWebhookReplyState);
}

/**
 * Meta does not honor Novalure's application idempotency key. Consequently an
 * attempt that may have crossed the network is held for manual reconciliation
 * instead of being sent a second time.
 */
export function getBotWebhookReplyAction(state: BotWebhookReplyState): BotWebhookReplyAction {
  if (state === "not_requested") return "attempt";
  if (state === "attempting" || state === "uncertain") return "hold";
  return "done";
}

export function getBotWebhookReplySettlement(
  deliveryStatus: "blocked" | "failed" | "queued" | "sent",
): Exclude<BotWebhookReplyState, "not_requested" | "attempting" | "not_applicable"> {
  if (deliveryStatus === "blocked") return "blocked";
  // A failure returned after the durable attempt began may represent a lost
  // acknowledgement. Without provider idempotency, retrying would risk a
  // duplicate customer message.
  if (deliveryStatus === "failed") return "uncertain";
  return "completed";
}

export function shouldReclaimBotWebhook(input: {
  leaseExpiresAt?: Date | null;
  now?: Date;
  status: string;
}) {
  if (input.status === "received" || input.status === "failed") return true;
  if (input.status !== "processing" || !input.leaseExpiresAt) return false;
  return input.leaseExpiresAt.getTime() <= (input.now ?? new Date()).getTime();
}
