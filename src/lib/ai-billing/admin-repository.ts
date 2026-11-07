import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, crmPayloadDigest, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import type { AiBookingRequest } from "./repository";

export type AiAdminRequest = AiBookingRequest & { workspaceId: string; workspaceName: string; requesterName: string; requesterEmail: string };
export type AiAdminReservation = { id: string; workspaceId: string; workspaceName: string; requestId: string; operation: string; reservedCredits: number; metadata: Record<string, unknown>; createdAt: string };
export type AiBillingAdminSnapshot = { source: "database"; canAdmin: true; requests: AiAdminRequest[]; reservations: AiAdminReservation[] };
export type AiBillingAdminAction = { action: "fulfill" | "close" | "reconcile"; requestId?: string; reservationId?: string; reference?: string; paidThrough?: string | null; status?: string; credits?: number; idempotencyKey: string };

function assertRole(session: AppSession) {
  if (!["owner", "admin"].includes(session.role) || !["platform_admin", "novalureAdmin"].includes(session.productRole)) {
    throw new CrmCommandError("AI_ADMIN_FORBIDDEN", "Nur die interne Novalure-Verwaltung kann Buchungen freischalten.", 403);
  }
}
function errorResponse(error: unknown): never {
  if (error instanceof CrmCommandError) throw error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501") throw new CrmCommandError("AI_ADMIN_FORBIDDEN", "Die interne Verwaltungsfreigabe fehlt.", 403);
  if (code === "23505" || /IDEMPOTENCY_CONFLICT/.test(message)) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Diese Vorgangskennung gehört zu einer anderen Freigabe.", 409);
  if (/AI_BOOKING_NOT_PENDING/.test(message)) throw new CrmCommandError("AI_BOOKING_NOT_PENDING", "Die Anfrage wurde bereits bearbeitet. Bitte neu laden.", 409);
  if (["23514", "22P02", "22007", "22008"].includes(code)) throw new CrmCommandError("AI_ADMIN_INVALID", "Anfrage, Referenz und bestätigten Zeitraum prüfen.", 400);
  throw new CrmCommandError("AI_ADMIN_UNAVAILABLE", "Die Buchungsverwaltung ist vorübergehend nicht verfügbar.", 503);
}
export async function readAdminAiBilling(session: AppSession, input: { status?: string; targetWorkspaceId?: string } = {}, options: TenantTransactionOptions = {}): Promise<AiBillingAdminSnapshot> {
  try {
    if (input.status && !["pending", "fulfilled", "cancelled"].includes(input.status)) throw new CrmCommandError("AI_ADMIN_INVALID", "Anfragestatus prüfen.", 400);
    if (input.targetWorkspaceId) assertCrmUuid(input.targetWorkspaceId);
    return await withCrmRead(session, async (tx, fresh) => {
      assertRole(fresh);
      const row = await tx.queryOne<{ data: AiBillingAdminSnapshot }>("select crm_ai_admin_read($1::uuid,$2::uuid,$3) as data", [fresh.workspaceId, input.targetWorkspaceId ?? null, input.status ?? "pending"]);
      if (!row?.data) throw new Error("AI_ADMIN_UNAVAILABLE");
      return row.data;
    }, options);
  } catch (error) { return errorResponse(error); }
}
export async function applyAdminAiBillingAction(session: AppSession, input: AiBillingAdminAction, options: TenantTransactionOptions = {}) {
  try {
    assertCrmUuid(input.idempotencyKey);
    if (!["fulfill", "close", "reconcile"].includes(input.action)) throw new CrmCommandError("AI_ADMIN_INVALID", "Verwaltungsaktion prüfen.", 400);
    if (input.requestId) assertCrmUuid(input.requestId);
    if (input.reservationId) assertCrmUuid(input.reservationId);
    if (input.action === "reconcile" ? !input.reservationId && !input.requestId : !input.requestId) throw new CrmCommandError("AI_ADMIN_INVALID", "Anfrage fehlt.", 400);
    if ((input.action === "fulfill" || input.action === "reconcile") && (!input.reference || input.reference.trim().length < 3 || input.reference.length > 200 || /[\r\n\x00]/u.test(input.reference))) throw new CrmCommandError("AI_ADMIN_INVALID", "Eine nachvollziehbare Rechnungs- oder Vereinbarungsreferenz ist erforderlich.", 400);
    if (input.action === "reconcile" && (!Number.isSafeInteger(input.credits) || Number(input.credits) < 0 || !["succeeded", "failed"].includes(input.status ?? ""))) throw new CrmCommandError("AI_ADMIN_INVALID", "Bestätigten Verbrauch prüfen.", 400);
    if (input.action === "close" && !["fulfilled", "cancelled"].includes(input.status ?? "")) throw new CrmCommandError("AI_ADMIN_INVALID", "Abschlussstatus prüfen.", 400);
    const { idempotencyKey, ...action } = input;
    return await withCrmRead(session, async (tx, fresh) => {
      assertRole(fresh);
      const digest = crmPayloadDigest({ actorId: fresh.userId, workspaceId: fresh.workspaceId, action });
      const row = await tx.queryOne<{ data: { status: string; replayed: boolean; actualCredits?: number } }>("select crm_ai_admin_action($1::uuid,$2::uuid,$3,$4::jsonb) as data", [fresh.workspaceId, idempotencyKey, digest, JSON.stringify(action)]);
      if (!row?.data) throw new Error("AI_ADMIN_UNAVAILABLE");
      return row.data;
    }, options);
  } catch (error) { return errorResponse(error); }
}
