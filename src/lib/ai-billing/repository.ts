import "server-only";
import { Pool } from "@neondatabase/serverless";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, crmPayloadDigest, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import { resolveDatabaseUrl } from "@/lib/db/client";
import { getLocalTestPool } from "@/lib/db/local-test-transport";
import { withTenantTransaction, type TenantPool, type TenantTransaction } from "@/lib/db/tenant-client";
import { runWithTenantTransaction } from "@/lib/db/transaction-context";
import { AI_CATALOG_VERSION, getAiPlan, getAiTopup, type AiPlanId } from "./catalog";

export type AiBookingRequest = {
  id: string; requestId: string; kind: "plan" | "topup" | "website"; itemId: string;
  status: "pending" | "fulfilled" | "cancelled"; amountCents: number | null; catalogVersion: string;
  createdAt: string; fulfilledAt: string | null; notes: string | null; requestedServices: string[];
};
export type AiCreditSnapshot = {
  source: "database"; workspaceId: string; planId: AiPlanId; paidThrough: string | null; cancelAtPeriodEnd: boolean;
  periodStart: string; periodEnd: string; monthlyCredits: number; monthlyRemaining: number;
  topupRemaining: number; availableCredits: number; reservedCredits: number; usedCredits: number;
  canBook: boolean; canRequestWebsite: boolean; bookings: AiBookingRequest[];
};
export type AiCreditReservation = {
  reservationId: string; requestId: string; reservedCredits: number;
  status: "reserved" | "succeeded" | "failed"; replayed: boolean;
};
export type AiCreditSettlement = {
  reservationId: string; actualCredits: number; status: "succeeded" | "failed"; replayed: boolean;
};
export type AiBookingInput = {
  requestId: string; kind: "plan" | "topup" | "website"; itemId: string; expectedCatalogVersion: string;
  notes?: string; requestedServices?: string[];
};

let creditPool: Pool | null = null;
let creditPoolUrl = "";
async function independentOptions(options: TenantTransactionOptions): Promise<TenantTransactionOptions> {
  if (options.pool) return options;
  const url = resolveDatabaseUrl();
  if (!url) throw new CrmCommandError("AI_BILLING_UNAVAILABLE", "Das KI-Kontingent ist noch nicht eingerichtet.", 503);
  const local = await getLocalTestPool(url);
  if (local) return { ...options, pool: local as unknown as TenantPool };
  if (creditPool && creditPoolUrl !== url) throw new CrmCommandError("AI_BILLING_UNAVAILABLE", "Das KI-Kontingent ist vorübergehend nicht verfügbar.", 503);
  if (!creditPool) {
    // A chatbot request may already hold a connection in the CRM's tenant pool.
    // A separate small pool prevents every outer request waiting for that same pool.
    creditPool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
    creditPoolUrl = url;
  }
  return { ...options, pool: creditPool };
}
function billingError(error: unknown): never {
  if (error instanceof CrmCommandError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("AI_CREDITS_EXHAUSTED")) throw new CrmCommandError("AI_CREDITS_EXHAUSTED", "Das KI-Kontingent ist aufgebraucht. Bitte weiteres Guthaben anfragen.", 402);
  if (message.includes("AI_CATALOG_CHANGED")) throw new CrmCommandError("AI_CATALOG_CHANGED", "Die Tarifauswahl wurde aktualisiert. Bitte neu laden.", 409);
  if (message.includes("IDEMPOTENCY_CONFLICT")) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Diese Anfrage-ID gehört zu einer anderen Aktion.", 409);
  if (/AI_BILLING_FORBIDDEN|AI_RESERVATION_UNAVAILABLE|AI_MODULE_DISABLED/.test(message)) throw new CrmCommandError("AI_BILLING_FORBIDDEN", "Für diese Aktion fehlt die Berechtigung.", 403);
  if (/AI_RESERVATION_INVALID|AI_SETTLEMENT_INVALID|AI_BOOKING_INVALID/.test(message)) throw new CrmCommandError("AI_BILLING_INVALID", "Die KI-Anfrage ist ungültig.", 400);
  throw new CrmCommandError("AI_BILLING_UNAVAILABLE", "Das KI-Kontingent ist noch nicht verfügbar. Es wurde keine kostenpflichtige KI-Anfrage gestartet.", 503);
}
/** Always commits separately, even when a caller already holds a CRM transaction. */
export async function withIndependentAiBillingTransaction<T>(
  session: AppSession,
  action: (tx: TenantTransaction, fresh: AppSession) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  try {
    const scope = { workspaceId: assertCrmUuid(session.workspaceId), actorId: assertCrmUuid(session.userId) };
    return await withTenantTransaction(scope, tx => runWithTenantTransaction(scope, tx, () => withCrmRead(session, action)), await independentOptions(options));
  } catch (error) { return billingError(error); }
}
export async function readAiCreditSnapshot(session: AppSession, options: TenantTransactionOptions = {}): Promise<AiCreditSnapshot> {
  return withIndependentAiBillingTransaction(session, async (tx, fresh) => {
    const row = await tx.queryOne<{ snapshot: Omit<AiCreditSnapshot, "workspaceId"> }>("select crm_ai_snapshot($1::uuid) as snapshot", [fresh.workspaceId]);
    if (!row?.snapshot) throw new CrmCommandError("AI_BILLING_UNAVAILABLE", "Das KI-Kontingent ist noch nicht eingerichtet.", 503);
    return { ...row.snapshot, workspaceId: fresh.workspaceId };
  }, options);
}
export async function reserveAiCredits(
  session: AppSession,
  input: { requestId: string; operation: string; credits: number; metadata?: Record<string, unknown> },
  options: TenantTransactionOptions = {},
): Promise<AiCreditReservation> {
  assertCrmUuid(input.requestId, "requestId");
  if (!Number.isSafeInteger(input.credits) || input.credits < 1 || input.credits > 100_000 || !/^[a-z][a-z0-9_.:-]{2,119}$/.test(input.operation)) throw new CrmCommandError("AI_BILLING_INVALID", "Die KI-Reservierung ist ungültig.", 400);
  const metadata = input.metadata ?? {};
  const allowedMetadata = new Set(["model", "meterVersion", "requestHash", "inputTokenBound", "maxOutputTokens"]);
  if (Object.keys(metadata).some(key => !allowedMetadata.has(key)) || Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096 || Object.values(metadata).some(value => typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) throw new CrmCommandError("AI_BILLING_INVALID", "Die KI-Reservierung enthält ungültige Metadaten.", 400);
  const hash = crmPayloadDigest({ actorId: session.userId, operation: input.operation, credits: input.credits, metadata });
  return withIndependentAiBillingTransaction(session, async (tx, fresh) => {
    if (!fresh.permissions.includes("bots:run")) throw new CrmCommandError("AI_BILLING_FORBIDDEN", "KI-Ausführung ist nicht freigeschaltet.", 403);
    const row = await tx.queryOne<{ result: AiCreditReservation }>("select crm_ai_reserve($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb) as result", [fresh.workspaceId, input.requestId, input.operation, input.credits, hash, JSON.stringify(metadata)]);
    return row!.result;
  }, options);
}
/** Failed means confirmed unbilled. Unknown provider results MUST keep their reservation. */
export async function settleAiCredits(
  session: AppSession,
  input: { requestId: string; actualCredits: number; status: "succeeded" | "failed" },
  options: TenantTransactionOptions = {},
): Promise<AiCreditSettlement> {
  assertCrmUuid(input.requestId, "requestId");
  if (!Number.isSafeInteger(input.actualCredits) || input.actualCredits < 0 || !["succeeded", "failed"].includes(input.status) || (input.status === "failed" && input.actualCredits !== 0)) throw new CrmCommandError("AI_BILLING_INVALID", "Die KI-Abrechnung ist ungültig.", 400);
  return withIndependentAiBillingTransaction(session, async (tx, fresh) => {
    const row = await tx.queryOne<{ result: AiCreditSettlement }>("select crm_ai_settle($1::uuid,$2::uuid,$3,$4) as result", [fresh.workspaceId, input.requestId, input.actualCredits, input.status]);
    return row!.result;
  }, options);
}
const serviceIds = new Set(["website_creation", "hosting", "maintenance", "content_updates"]);
export async function requestAiBooking(session: AppSession, input: AiBookingInput, options: TenantTransactionOptions = {}): Promise<AiBookingRequest> {
  assertCrmUuid(input.requestId, "requestId");
  if (input.expectedCatalogVersion !== AI_CATALOG_VERSION) throw new CrmCommandError("AI_CATALOG_CHANGED", "Die Tarifauswahl wurde aktualisiert. Bitte neu laden.", 409);
  if (!["plan", "topup", "website"].includes(input.kind) || (input.kind === "plan" && !getAiPlan(input.itemId)) || (input.kind === "topup" && !getAiTopup(input.itemId)) || (input.kind === "website" && input.itemId !== "real_estate_website")) throw new CrmCommandError("AI_BILLING_INVALID", "Das Angebot ist ungültig.", 400);
  const notes = input.notes?.trim() || null;
  const requestedServices = [...new Set(input.requestedServices ?? [])].sort();
  if ((notes?.length ?? 0) > 2000 || requestedServices.length > 4 || requestedServices.some(id => !serviceIds.has(id)) || (input.kind !== "website" && (notes !== null || requestedServices.length))) throw new CrmCommandError("AI_BILLING_INVALID", "Die Angebotsanfrage ist ungültig.", 400);
  const hash = crmPayloadDigest({ actorId: session.userId, kind: input.kind, itemId: input.itemId, catalogVersion: input.expectedCatalogVersion, notes, requestedServices });
  return withIndependentAiBillingTransaction(session, async (tx, fresh) => {
    if (input.kind !== "website" && (!fresh.permissions.includes("settings:manage") || !fresh.productPermissions.includes("settings:manage"))) throw new CrmCommandError("AI_BILLING_FORBIDDEN", "Nur die Unternehmensverwaltung kann KI-Angebote anfragen.", 403);
    const row = await tx.queryOne<{ result: Record<string, unknown> }>("select crm_ai_request_booking($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb) as result", [fresh.workspaceId, input.requestId, input.kind, input.itemId, input.expectedCatalogVersion, hash, notes, JSON.stringify(requestedServices)]);
    const result = row!.result;
    return {
      id: String(result.id), requestId: String(result.request_id), kind: result.kind as AiBookingRequest["kind"], itemId: String(result.item_id),
      status: result.status as AiBookingRequest["status"], amountCents: result.amount_cents === null ? null : Number(result.amount_cents), catalogVersion: String(result.catalog_version),
      createdAt: String(result.created_at), fulfilledAt: result.fulfilled_at === null ? null : String(result.fulfilled_at), notes: result.notes === null ? null : String(result.notes), requestedServices: result.requested_services as string[],
    };
  }, options);
}
