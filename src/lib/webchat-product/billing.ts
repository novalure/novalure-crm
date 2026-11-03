import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "../auth/session";
import { assertCrmUuid, CrmCommandError, withCrmRead } from "../crm-command";
import { withTenantTransaction, type TenantScope, type TenantTransactionOptions } from "../db/tenant-client";
import { KnowledgeBillingError, verifyStripeKnowledgeSignature } from "../knowledge-center/billing";

export type WebchatProductOptions = TenantTransactionOptions & { env?: NodeJS.ProcessEnv };
export function assertWebchatProductIsolated(env: NodeJS.ProcessEnv = process.env) {
  if (env.NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED !== "1" || env.VERCEL_ENV === "production") {
    throw new CrmCommandError("WEBCHAT_PRODUCT_DISABLED", "Das isolierte Webchat-Kundenprodukt ist nicht aktiviert.", 403);
  }
}

function billingFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (["IDEMPOTENCY_CONFLICT","PAYMENT_EVENT_CONFLICT","PAYMENT_ORDER_MISMATCH","OFFER_UNAVAILABLE"].includes(message)) {
    throw new CrmCommandError(message, "Bestellung und Zahlungsnachweis stimmen nicht überein.", 409);
  }
  throw error;
}

/** Records a deliberate request. No checkout, charge, invoice or entitlement is created. */
export async function createWebchatTopupOrder(session: AppSession, input: { requestId: string; offerReference: string; expectedOfferRevision: number }, options: WebchatProductOptions = {}) {
  assertWebchatProductIsolated(options.env);
  assertCrmUuid(input.requestId,"requestId");
  if (typeof input.offerReference !== "string" || input.offerReference.length < 1 || input.offerReference.length > 160 ||
    !Number.isSafeInteger(input.expectedOfferRevision) || input.expectedOfferRevision < 1) {
    throw new CrmCommandError("VALIDATION_ERROR","Ungültiges Zusatzkontingent.");
  }
  try {
    return await withCrmRead(session,async (tx,fresh) => {
      if (!fresh.productPermissions.includes("settings:manage") || !fresh.permissions.includes("crm:write")) throw new CrmCommandError("FORBIDDEN","Kundenadministrator erforderlich.",403);
      const result = (await tx.queryOne<{ result: { orderId: string; status: "pending" | "paid" | "cancelled"; units: number; replayed: boolean } }>("select webchat_create_topup_order($1::uuid,$2::uuid,$3,$4::integer) as result",[fresh.workspaceId,input.requestId,input.offerReference,input.expectedOfferRevision]))?.result;
      if (!result) throw new CrmCommandError("NOT_FOUND","Zusatzkontingent nicht verfügbar.",404);
      return result;
    },options);
  } catch(error) { return billingFailure(error); }
}

function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeBillingError("billing_event_invalid");
  return value as Record<string,unknown>;
}
function providerId(value: unknown,prefix: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`,"u").test(value)) throw new KnowledgeBillingError("billing_event_invalid");
  return value;
}

/**
 * Isolated consumer of the existing Stripe signature adapter. A host-side,
 * previously persisted customer/account/payment-intent binding is mandatory.
 * Event metadata and checkout redirects never supply tenant, units or rights.
 * No Production route, checkout or provider request is installed here.
 */
export async function processWebchatTestPayment(input: WebchatProductOptions & {
  scope: TenantScope; rawBody: Uint8Array; signature: string | null; secret: string; nowSeconds?: number;
}) {
  assertWebchatProductIsolated(input.env);
  assertCrmUuid(input.scope.workspaceId); assertCrmUuid(input.scope.actorId);
  verifyStripeKnowledgeSignature(input.rawBody,input.signature,input.secret,input.nowSeconds);
  let event: Record<string,unknown>;
  try { event = record(JSON.parse(Buffer.from(input.rawBody).toString("utf8"))); }
  catch { throw new KnowledgeBillingError("billing_event_invalid"); }
  const eventId = providerId(event.id,"evt");
  if (event.livemode !== false) throw new KnowledgeBillingError("billing_test_event_required");
  if (!Number.isSafeInteger(event.created) || Number(event.created) < 0 || typeof event.type !== "string" || event.type.length > 120) throw new KnowledgeBillingError("billing_event_invalid");
  if (event.type !== "payment_intent.succeeded") return { eventId,workspaceId:input.scope.workspaceId,outcome:"ignored" as const };
  const payment = record(record(event.data).object);
  if (payment.status !== "succeeded" || !Number.isSafeInteger(payment.amount_received) || Number(payment.amount_received) < 0 ||
    typeof payment.currency !== "string" || !/^[a-z]{3}$/u.test(payment.currency)) throw new KnowledgeBillingError("billing_payment_unconfirmed");
  const paymentId = providerId(payment.id,"pi");
  const customer = providerId(typeof payment.customer === "object" ? record(payment.customer).id : payment.customer,"cus");
  const account = event.account === undefined ? "" : providerId(event.account,"acct");
  const digest = createHash("sha256").update(input.rawBody).digest("hex");
  const currency = payment.currency.toUpperCase();
  try {
    const result = await withTenantTransaction(input.scope,async tx => {
      const row = await tx.queryOne<{ outcome: "applied" | "duplicate" | "stale" }>("select webchat_apply_test_payment($1::uuid,$2,$3,$4,$5,$6,$7::bigint,$8,$9) as outcome",
        [input.scope.workspaceId,account,customer,paymentId,eventId,digest,Number(event.created),String(payment.amount_received),currency]);
      if (!row) throw new CrmCommandError("PAYMENT_UNAVAILABLE","Zahlungsnachweis nicht verfügbar.",503);
      return row.outcome;
    },input);
    return { eventId,workspaceId:input.scope.workspaceId,outcome:result };
  } catch(error) { return billingFailure(error); }
}
