import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, type CrmCommandContext, type TenantTransaction } from "@/lib/crm-command";
import { assertRecordWriteAccess } from "@/lib/db/crm-write-repositories";
import { hasProductCapability } from "@/lib/product-model";

export type ReservationReviewAction = "reservation.request" | "reservation.confirm" | "reservation.extend" | "reservation.expire";
const titles: Record<ReservationReviewAction, string> = {
  "reservation.request": "Reservierungsanfrage manuell prüfen",
  "reservation.confirm": "Bestätigte Reservierung manuell prüfen",
  "reservation.extend": "Reservierungsverlängerung manuell prüfen",
  "reservation.expire": "Abgelaufene Reservierung manuell nachbereiten",
};

/** The normal task route's capability and record/owner rules also apply to derived tasks. */
export async function assertReservationReviewTaskAccess(tx: TenantTransaction, session: AppSession, projectId: string) {
  if (!session.permissions.includes("crm:write") || !hasProductCapability(session.productRole, "workspace:operate")) {
    throw new CrmCommandError("FORBIDDEN", "Task creation capability is not granted", 403);
  }
  await assertProjectGrant(tx, session, projectId, true);
  const access = await assertRecordWriteAccess({ entityLabel: "Task", ownerUserId: session.userId, projectId, session });
  if (!access.ok) throw new CrmCommandError("FORBIDDEN", access.reason, 403);
}

/** Only called inside the successful sales-command callback; replay never invokes it. */
export async function createReservationReviewTask(
  tx: TenantTransaction, context: CrmCommandContext, action: ReservationReviewAction,
  unit: Record<string, unknown>, reservation: Record<string, unknown> | null,
): Promise<string> {
  if (!context.projectId) throw new CrmCommandError("SAVE_UNCONFIRMED", "Reservation project was not confirmed", 503);
  await assertReservationReviewTaskAccess(tx, context.session, context.projectId);
  if (!reservation || reservation.workspace_id !== context.workspaceId || reservation.project_id !== context.projectId
    || unit.workspace_id !== context.workspaceId || unit.project_id !== context.projectId || reservation.unit_id !== unit.id) {
    throw new CrmCommandError("SAVE_UNCONFIRMED", "Reservation follow-up scope was not confirmed", 503);
  }
  const reservationId = assertCrmUuid(reservation.id, "reservationId"), unitId = assertCrmUuid(unit.id, "unitId");
  const number = typeof unit.unit_number === "string" ? unit.unit_number.slice(0, 80) : "";
  const task = await tx.queryOne<{ id: string }>(`insert into tasks
    (workspace_id,project_id,contact_id,lead_id,owner_user_id,title,due_at,priority,status,metadata)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,null,'Normal','open',$7::jsonb) returning id`,
  [context.workspaceId, context.projectId, reservation.contact_id ?? null, reservation.buyer_lead_id ?? null, context.actorId,
    titles[action] + (number ? ` · Einheit ${number}` : ""),
    JSON.stringify({ source: "reservation_manual_review", reservationId, unitId, action, manualReviewOnly: true,
      commandId: context.commandId, reservationExpiresAt: reservation.expires_at ?? null })]);
  if (!task) throw new CrmCommandError("SAVE_UNCONFIRMED", "Reservation follow-up was not confirmed", 503);
  return task.id;
}
