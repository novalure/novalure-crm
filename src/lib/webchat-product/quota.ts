import "server-only";
import { createHash } from "node:crypto";
import { assertCrmUuid, CrmCommandError } from "../crm-command";
import type { TenantTransaction } from "../db/tenant-client";

export type WebchatUsageReservation = { state: "reserved" | "consumed" | "released"; replayed: boolean; response: string | null };
export type WebchatUsage = {
  enabled: boolean; quotaUnits: number; usedUnits: number; reservedUnits: number; remainingUnits: number; paused: boolean;
  contractReference: string;
  bots: { botId: string; usedUnits: number; reservedUnits: number }[];
  offers: { reference: string; revision: number; units: number; amountMinor: string; currency: string; contractReference: string }[];
  orders: { id: string; offerReference: string; units: number; status: "pending" | "paid" | "cancelled"; createdAt: string; paidAt: string | null }[];
};

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message === "LIMIT_EXCEEDED") throw new CrmCommandError("LIMIT_EXCEEDED", "Das gemeinsame Webchat-Kontingent ist ausgeschöpft.", 409);
  if (message === "IDEMPOTENCY_CONFLICT") throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Die Anfragekennung gehört zu einer anderen Anfrage.", 409);
  if (message === "WEBCHAT_PRODUCT_DISABLED") throw new CrmCommandError("ENTITLEMENT_REQUIRED", "Webchat ist für dieses Kundenkonto pausiert.", 403);
  throw error;
}

export async function readWebchatUsage(tx: TenantTransaction, workspaceId: string): Promise<WebchatUsage | null> {
  assertCrmUuid(workspaceId, "workspaceId");
  const installed = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.webchat_product_accounts') is not null as installed");
  if (!installed?.installed) return null;
  const account = await tx.queryOne<{ enabled: boolean; quotaUnits: string; usedUnits: string; reservedUnits: string; contractReference: string }>(
    'select enabled,quota_units::text as "quotaUnits",used_units::text as "usedUnits",reserved_units::text as "reservedUnits",contract_reference as "contractReference" from webchat_product_accounts where workspace_id=$1::uuid', [workspaceId]);
  if (!account) return null;
  const bots = await tx.query<{ botId: string; usedUnits: string; reservedUnits: string }>(`select bot_id as "botId",coalesce(sum(units) filter(where state='consumed'),0)::text as "usedUnits",coalesce(sum(units) filter(where state='reserved'),0)::text as "reservedUnits" from webchat_product_usage where workspace_id=$1::uuid group by bot_id order by bot_id`, [workspaceId]);
  const offers = await tx.query<{ reference: string; revision: number; units: string; amountMinor: string; currency: string; contractReference: string }>('select reference,revision,units::text,amount_minor as "amountMinor",currency,contract_reference as "contractReference" from webchat_product_offers where workspace_id=$1::uuid and active order by reference,revision', [workspaceId]);
  const orders = await tx.query<{ id: string; offerReference: string; units: string; status: "pending" | "paid" | "cancelled"; createdAt: string; paidAt: string | null }>('select id,offer_reference as "offerReference",units::text,status,created_at::text as "createdAt",paid_at::text as "paidAt" from webchat_product_orders where workspace_id=$1::uuid order by created_at desc limit 100', [workspaceId]);
  const quotaUnits = Number(account.quotaUnits), usedUnits = Number(account.usedUnits), reservedUnits = Number(account.reservedUnits);
  const remainingUnits = quotaUnits - usedUnits - reservedUnits;
  return { enabled: account.enabled, quotaUnits, usedUnits, reservedUnits, remainingUnits, paused: !account.enabled || remainingUnits <= 0, contractReference: account.contractReference,
    bots: bots.map(row => ({ ...row, usedUnits: Number(row.usedUnits), reservedUnits: Number(row.reservedUnits) })),
    offers: offers.map(row => ({ ...row, units: Number(row.units) })), orders: orders.map(row => ({ ...row, units: Number(row.units) })) };
}

/** A durable reservation precedes provider invocation. Unknown outcomes remain reserved. */
export async function reserveWebchatUsage(tx: TenantTransaction, input: { workspaceId: string; botId: string; requestId: string; units?: number; requestDigest?: string }): Promise<WebchatUsageReservation | null> {
  assertCrmUuid(input.workspaceId); assertCrmUuid(input.botId); assertCrmUuid(input.requestId);
  const units = input.units ?? 1;
  if (!Number.isSafeInteger(units) || units < 1) throw new CrmCommandError("VALIDATION_ERROR", "Ungültige Verbrauchseinheit.");
  const digest = input.requestDigest ?? createHash("sha256").update(JSON.stringify([input.botId,input.requestId])).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new CrmCommandError("VALIDATION_ERROR", "Ungültige Anfragebindung.");
  try { return (await tx.queryOne<{ result: WebchatUsageReservation | null }>("select webchat_reserve_usage($1::uuid,$2::uuid,$3::uuid,$4,$5::bigint) as result", [input.workspaceId,input.botId,input.requestId,digest,units]))?.result ?? null; }
  catch (error) { return translate(error); }
}

export async function settleWebchatUsage(tx: TenantTransaction, input: { workspaceId: string; botId: string; requestId: string; outcome: "consumed" | "released"; response?: string | null }): Promise<WebchatUsageReservation> {
  assertCrmUuid(input.workspaceId); assertCrmUuid(input.botId); assertCrmUuid(input.requestId);
  if (input.response !== undefined && input.response !== null && (typeof input.response !== "string" || Buffer.byteLength(input.response) > 32768)) throw new CrmCommandError("VALIDATION_ERROR", "Ungültige Antwortgröße.");
  try {
    const result = (await tx.queryOne<{ result: WebchatUsageReservation }>("select webchat_settle_usage($1::uuid,$2::uuid,$3::uuid,$4,$5) as result", [input.workspaceId,input.botId,input.requestId,input.outcome,input.response ?? null]))?.result;
    if (!result) throw new CrmCommandError("NOT_FOUND", "Verbrauchsreservierung nicht verfügbar.", 404);
    return result;
  } catch (error) { return translate(error); }
}
