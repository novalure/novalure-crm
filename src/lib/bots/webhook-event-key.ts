import { createHash } from "node:crypto";

export function hashBotWebhookValue(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Fixed-width opaque identity safe for PostgreSQL B-tree unique indexes. */
export function getDurableBotWebhookEventKey(providerEventIdentity: string) {
  return `evt_${hashBotWebhookValue(providerEventIdentity)}`;
}
