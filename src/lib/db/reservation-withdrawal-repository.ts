import type { AppSession } from "@/lib/auth/session";
import { CrmCommandError } from "@/lib/crm-command";
import type { TenantTransaction } from "@/lib/db/tenant-client";

type Row = Record<string, unknown>;

/** Called only with the current reservation and unit locked, after fresh project authority and CAS checks. */
export async function withdrawReservationInTransaction(
  tx: TenantTransaction, session: AppSession, projectId: string,
  reservation: Row, unit: Row, authorityId: unknown, sourceReference: string,
) {
  const workspaceId = session.workspaceId;
  const competing = await tx.queryOne(`select id from property_reservations
    where workspace_id=$1 and project_id=$2 and unit_id=$3 and id<>$4
      and status in ('requested','hold','reserved')`, [workspaceId, projectId, unit.id, reservation.id]);
  if (competing) throw new CrmCommandError("CONFLICT", "Another open reservation exists; review the inventory before withdrawing", 409);
  const releaseUnit = unit.status === "reserved";
  if (releaseUnit && ((unit.buyer_contact_id && unit.buyer_contact_id !== reservation.contact_id)
    || (unit.deal_id && unit.deal_id !== reservation.deal_id))) {
    throw new CrmCommandError("CONFLICT", "Unit assignment changed; reload before withdrawing", 409);
  }
  const evidence = {
    sourceReference, authorityId, withdrawnBy: session.userId, withdrawnAt: new Date().toISOString(),
    previousStatus: reservation.status, reservationVersion: Number(reservation.version) + 1,
    unitVersion: Number(unit.version) + Number(releaseUnit),
  };
  const saved = await tx.queryOne<Row>(`update property_reservations
    set status='withdrawn',metadata=metadata || jsonb_build_object('withdrawal',$4::jsonb),
      version=version+1,updated_at=now()
    where workspace_id=$1 and project_id=$2 and id=$3 returning *`,
  [workspaceId, projectId, reservation.id, JSON.stringify(evidence)]);
  const savedUnit = releaseUnit ? await tx.queryOne<Row>(`update property_units
    set status='available',buyer_contact_id=null,deal_id=null,version=version+1,updated_at=now()
    where workspace_id=$1 and project_id=$2 and id=$3 returning *`, [workspaceId, projectId, unit.id]) : unit;
  // Legacy tasks have no reliable reservation link. Keep them and all financial/contract records intact.
  const task = await tx.queryOne<Row>(`insert into tasks
    (workspace_id,project_id,contact_id,lead_id,owner_user_id,title,due_at,priority,status,metadata)
    values($1,$2,$3,$4,$5,$6,now(),'Normal','open',$7::jsonb) returning *`,
  [workspaceId, projectId, reservation.contact_id, reservation.buyer_lead_id, session.userId,
    `Reservierung zurückgenommen: Einheit ${unit.unit_number} – vertragliche Folgen und Anzahlung manuell prüfen`,
    JSON.stringify({ reservationId: reservation.id, unitId: unit.id, source: "reservation_withdrawal", manualReviewOnly: true })]);
  if (!saved || !savedUnit || !task) throw new CrmCommandError("SAVE_UNCONFIRMED", "Withdrawal was not confirmed", 503);
  await tx.execute(`insert into audit_logs
    (workspace_id,actor_user_id,project_id,action,entity_type,entity_id,before,after)
    values($1,$2,$3,'reservation.withdrawn','property_reservation',$4,$5::jsonb,$6::jsonb)`,
  [workspaceId, session.userId, projectId, reservation.id,
    JSON.stringify({ reservation, unit }), JSON.stringify({ reservation: saved, unit: savedUnit, taskId: task.id })]);
  if (releaseUnit) await tx.execute(`insert into property_unit_audit_events
    (workspace_id,project_id,unit_id,actor_user_id,event_type,before,after,reason,metadata)
    values($1,$2,$3,$4,'authorized_sales_transition',$5::jsonb,$6::jsonb,$7,$8::jsonb)`,
  [workspaceId, projectId, unit.id, session.userId, JSON.stringify(unit), JSON.stringify(savedUnit),
    sourceReference, JSON.stringify({ reservationId: reservation.id, action: "reservation.withdraw" })]);
  return { entity: "reservation", record: saved, unitVersion: Number(savedUnit.version), taskId: task.id };
}
