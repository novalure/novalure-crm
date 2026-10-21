import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class KnowledgeBillingError extends Error {
  constructor(readonly code: string) { super(code); this.name = "KnowledgeBillingError"; }
}

export type KnowledgeEntitlementGrant = Readonly<{
  enabled: boolean;
  /** Contract/catalog identifiers are assigned on the server; no pricing is defined here. */
  contractReference: string;
  features: Readonly<Record<string, boolean>>;
  limits: Readonly<Record<string, number>>;
  accessState: "active" | "grace" | "suspended" | "cancelled";
}>;
export type StripeSubscriptionSnapshot = Readonly<{
  subscriptionId: string;
  customerId: string;
  accountId: string | null;
  priceIds: readonly string[];
  status: "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}>;
type EventReceipt = Readonly<{
  provider: "stripe";
  eventId: string;
  eventType: string;
  eventCreatedAt: number;
  eventDigest: string;
}>;
export type KnowledgeBillingPorts = Readonly<{
  /** Resolve using a previously stored customer/account mapping, never event metadata. */
  resolveTenant(input: Readonly<{ customerId: string; accountId: string | null }>): Promise<Readonly<{ workspaceId: string }> | null>;
  /** Reads a trusted contract/catalog. Payment failure access/grace rules belong here. */
  mapSubscription(input: StripeSubscriptionSnapshot, workspaceId: string): Promise<KnowledgeEntitlementGrant>;
  /**
   * Required transactional boundary: uniquely lock provider+eventId, reject digest
   * reuse, recheck customer-to-tenant mapping, ignore older subscription events,
   * write grant+subscription cursor+receipt+audit atomically. Must be concurrency safe.
   */
  applyVerifiedEventOnce(input: EventReceipt & Readonly<{
    workspaceId: string;
    subscription: StripeSubscriptionSnapshot;
    grant: KnowledgeEntitlementGrant;
  }>): Promise<"applied" | "duplicate" | "stale">;
  recordIgnoredEventOnce(input: EventReceipt): Promise<void>;
}>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeBillingError("billing_event_invalid");
  return value as Record<string, unknown>;
}

/** Raw bytes must be retained before JSON parsing; public request fields cannot grant access. */
export function verifyStripeKnowledgeSignature(rawBody: Uint8Array, signature: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1_000)) {
  if (!secret || secret.length < 16) throw new KnowledgeBillingError("billing_webhook_unconfigured");
  if (rawBody.byteLength > 262_144) throw new KnowledgeBillingError("billing_event_too_large");
  if (!signature || signature.length > 4_096 || /[\r\n]/u.test(signature)) throw new KnowledgeBillingError("billing_signature_invalid");
  const fields = signature.split(",").map((entry) => entry.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t");
  const signatures = fields.filter(([key, value]) => key === "v1" && /^[0-9a-f]{64}$/iu.test(value ?? "")).map(([, value]) => value);
  if (timestamps.length !== 1 || !/^\d{1,12}$/u.test(timestamps[0][1] ?? "") || !signatures.length || signatures.length > 8) {
    throw new KnowledgeBillingError("billing_signature_invalid");
  }
  const timestamp = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > 300) throw new KnowledgeBillingError("billing_signature_expired");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  if (!signatures.some((value) => timingSafeEqual(expected, Buffer.from(value, "hex")))) throw new KnowledgeBillingError("billing_signature_invalid");
}

function stripeId(value: unknown, prefix: string) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`, "u").test(value)) {
    throw new KnowledgeBillingError("billing_event_invalid");
  }
  return value;
}

/**
 * Prepared server-only adapter. Deliberately no route, checkout, products, prices,
 * subscriptions, provider requests or production entitlement writer is installed.
 */
export async function processStripeKnowledgeWebhook(input: Readonly<{
  rawBody: Uint8Array;
  signature: string | null;
  secret: string;
  ports: KnowledgeBillingPorts;
  nowSeconds?: number;
}>) {
  verifyStripeKnowledgeSignature(input.rawBody, input.signature, input.secret, input.nowSeconds);
  let event: Record<string, unknown>;
  try { event = object(JSON.parse(Buffer.from(input.rawBody).toString("utf8"))); }
  catch { throw new KnowledgeBillingError("billing_event_invalid"); }
  const eventId = stripeId(event.id, "evt");
  if (typeof event.type !== "string" || event.type.length > 120 || !Number.isSafeInteger(event.created) || Number(event.created) < 0) {
    throw new KnowledgeBillingError("billing_event_invalid");
  }
  const receipt: EventReceipt = {
    provider: "stripe", eventId, eventType: event.type, eventCreatedAt: Number(event.created),
    eventDigest: createHash("sha256").update(input.rawBody).digest("hex"),
  };
  if (!["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await input.ports.recordIgnoredEventOnce(receipt);
    return { eventId, outcome: "ignored" as const };
  }
  const subscription = object(object(event.data).object);
  const customerId = stripeId(typeof subscription.customer === "object" ? object(subscription.customer).id : subscription.customer, "cus");
  const accountId = event.account === undefined ? null : stripeId(event.account, "acct");
  const items = object(subscription.items).data;
  if (!Array.isArray(items) || items.length > 100) throw new KnowledgeBillingError("billing_event_invalid");
  const priceIds = [...new Set(items.map((item) => stripeId(object(object(item).price).id, "price")))];
  const status = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
  if (typeof status !== "string" || !["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"].includes(status)) {
    throw new KnowledgeBillingError("billing_event_invalid");
  }
  const period = subscription.current_period_end;
  if (period !== undefined && (!Number.isSafeInteger(period) || Number(period) < 0)) throw new KnowledgeBillingError("billing_event_invalid");
  const snapshot: StripeSubscriptionSnapshot = {
    subscriptionId: stripeId(subscription.id, "sub"), customerId, accountId, priceIds,
    status: status as StripeSubscriptionSnapshot["status"],
    currentPeriodEnd: period === undefined ? null : Number(period),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  };
  const tenant = await input.ports.resolveTenant({ customerId, accountId });
  if (!tenant || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenant.workspaceId)) {
    throw new KnowledgeBillingError("billing_customer_unmapped");
  }
  const grant = await input.ports.mapSubscription(snapshot, tenant.workspaceId);
  if (!grant.contractReference || !["active", "grace", "suspended", "cancelled"].includes(grant.accessState) ||
    typeof grant.enabled !== "boolean" || Object.values(grant.features).some((value) => typeof value !== "boolean") ||
    Object.values(grant.limits).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new KnowledgeBillingError("billing_contract_invalid");
  }
  const outcome = await input.ports.applyVerifiedEventOnce({ ...receipt, workspaceId: tenant.workspaceId, subscription: snapshot, grant });
  return { eventId, workspaceId: tenant.workspaceId, outcome };
}
