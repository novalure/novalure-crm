import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import type { PropertySalesHistoryItem, PropertySalesHistoryKind, PropertySalesHistoryPage } from "@/lib/property-sales-history";

type Input = { projectId: string; unitId: string; reservationId?: string | null; cursor?: string };
type Scope = { workspaceId: string; projectId: string; unitId: string; reservationId: string | null };
type Cursor = Scope & { v: 1; at: string; rank: 0 | 1; id: string };
type HistoryRow = {
  id: string; source: "reservation_command" | "unit_audit"; kind: PropertySalesHistoryKind;
  at: string; rank: 0 | 1; actorId: string | null; actorName: string | null; reservationId: string | null;
  beforeStatus: unknown; afterStatus: unknown; beforeExpiry: unknown; afterExpiry: unknown;
  reservationVersion: unknown; unitVersion: unknown; taskId: string | null; sourceReference: unknown;
};
const pageSize = 40;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const statuses = new Set(["requested", "hold", "reserved", "expired", "converted", "withdrawn"]);
const unitStatuses = new Set(["available", "reserved", "sold", "blocked"]);
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null;
}
function version(value: unknown): number | null {
  if (!(typeof value === "number" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value)))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function instant(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
const status = (value: unknown, source: HistoryRow["source"]) => typeof value === "string"
  && (source === "unit_audit" ? unitStatuses : statuses).has(value) ? value : null;
function decodeCursor(value: string | undefined, scope: Scope): Cursor | null {
  if (value === undefined) return null;
  try {
    if (value.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!c || c.v !== 1 || c.workspaceId !== scope.workspaceId || c.projectId !== scope.projectId || c.unitId !== scope.unitId
      || c.reservationId !== scope.reservationId || typeof c.at !== "string" || !timestamp.test(c.at) || !Number.isFinite(Date.parse(c.at))
      || ![0, 1].includes(c.rank) || typeof c.id !== "string" || !uuid.test(c.id)
      || Object.keys(c).some(key => !["v", "workspaceId", "projectId", "unitId", "reservationId", "at", "rank", "id"].includes(key))) throw new Error();
    return c;
  } catch { throw new CrmCommandError("INVALID_HISTORY_CURSOR", "The history page cursor is invalid", 400); }
}

/** Reads only allowlisted fields; raw receipts, audit payloads, prices and buyer details never leave SQL. */
export async function loadPropertySalesHistory(session: AppSession, input: Input, options: TenantTransactionOptions = {}): Promise<PropertySalesHistoryPage> {
  const scope: Scope = {
    workspaceId: assertCrmUuid(session.workspaceId, "workspaceId").toLowerCase(),
    projectId: assertCrmUuid(input.projectId, "projectId").toLowerCase(),
    unitId: assertCrmUuid(input.unitId, "unitId").toLowerCase(),
    reservationId: input.reservationId == null ? null : assertCrmUuid(input.reservationId, "reservationId").toLowerCase(),
  };
  const cursor = decodeCursor(input.cursor, scope);
  return withCrmRead(session, async (tx, fresh) => {
    await assertProjectGrant(tx, fresh, scope.projectId, false);
    const unit = await tx.queryOne(`select id from property_units where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid`, [fresh.workspaceId, scope.projectId, scope.unitId]);
    if (!unit) throw new CrmCommandError("HISTORY_NOT_AVAILABLE", "Unit history is not available in this project", 404);
    if (scope.reservationId) {
      const reservation = await tx.queryOne(`select id from property_reservations where workspace_id=$1::uuid and project_id=$2::uuid and unit_id=$3::uuid and id=$4::uuid`, [fresh.workspaceId, scope.projectId, scope.unitId, scope.reservationId]);
      if (!reservation) throw new CrmCommandError("HISTORY_NOT_AVAILABLE", "Reservation history is not available for this unit", 404);
    }
    const rows = await tx.query<HistoryRow>(`with history as (
      select e.id,e.created_at as event_at,0 as rank,'reservation_command'::text as source,
        substring(e.event_type from 16) as kind,e.actor_user_id as actor_id,r.id as reservation_id,
        case when e.event_type='property_sales.reservation.withdraw'
          then coalesce(c.response#>>'{historyBefore,status}',c.response#>>'{record,metadata,withdrawal,previousStatus}')
          else c.response#>>'{historyBefore,status}' end as before_status,c.response#>>'{record,status}' as after_status,
        c.response#>>'{historyBefore,expiresAt}' as before_expiry,c.response#>>'{record,expires_at}' as after_expiry,
        c.response#>>'{record,version}' as reservation_version,c.response->>'unitVersion' as unit_version,t.id as task_id,
        case e.event_type
          when 'property_sales.reservation.confirm' then c.response#>>'{record,confirmation,sourceReference}'
          when 'property_sales.reservation.extend' then c.response#>>'{record,metadata,lastExtension,sourceReference}'
          when 'property_sales.reservation.withdraw' then c.response#>>'{record,metadata,withdrawal,sourceReference}'
          else null end as source_reference
      from crm_domain_events e join crm_command_receipts c on c.workspace_id=e.workspace_id and c.id=e.command_id
        and c.project_id=e.project_id and c.actor_user_id=e.actor_user_id and c.operation=e.event_type
        and c.audit_reference=e.audit_reference and c.correlation_id=e.correlation_id
        and c.resource_id is not distinct from e.resource_id
        and c.data_classification=e.data_classification and c.data_purpose=e.data_purpose
      join property_reservations r on r.workspace_id=e.workspace_id and r.project_id=e.project_id
        and r.id::text=c.response#>>'{record,id}' and r.unit_id=$3::uuid
      left join tasks t on t.workspace_id=e.workspace_id and t.project_id=e.project_id
        and t.id::text=c.response->>'taskId'
        and t.metadata->>'reservationId'=r.id::text and t.metadata->>'unitId'=$3::text
        and t.metadata->>'manualReviewOnly'='true'
        and ((t.metadata->>'source'='reservation_manual_review' and t.metadata->>'commandId'=e.command_id::text
          and t.metadata->>'action'=substring(e.event_type from 16))
          or (e.event_type='property_sales.reservation.withdraw' and t.metadata->>'source'='reservation_withdrawal'))
      where e.workspace_id=$1::uuid and e.project_id=$2::uuid and ($4::uuid is null or r.id=$4::uuid)
        and e.event_type in ('property_sales.reservation.request','property_sales.reservation.confirm',
          'property_sales.reservation.extend','property_sales.reservation.expire','property_sales.reservation.withdraw')
        and c.response->>'entity'='reservation' and c.response#>>'{record,workspace_id}'=$1::text
        and c.response#>>'{record,project_id}'=$2::text and c.response#>>'{record,unit_id}'=$3::text
        and (e.resource_id is null or e.resource_id=r.id)
        and c.response#>>'{record,status}'=case e.event_type
          when 'property_sales.reservation.request' then 'requested' when 'property_sales.reservation.confirm' then 'reserved'
          when 'property_sales.reservation.extend' then 'reserved' when 'property_sales.reservation.expire' then 'expired'
          when 'property_sales.reservation.withdraw' then 'withdrawn' end
      union all
      select a.id,a.created_at,1,'unit_audit','unit.audit',a.actor_user_id,
        case when r.id is not null then r.id else null end,
        a.before->>'status',a.after->>'status',null,null,null,a.after->>'version',null,null
      from property_unit_audit_events a left join property_reservations r on r.workspace_id=a.workspace_id
        and r.project_id=a.project_id and r.unit_id=a.unit_id and r.id::text=a.metadata->>'reservationId'
      where a.workspace_id=$1::uuid and a.project_id=$2::uuid and a.unit_id=$3::uuid
        and ($4::uuid is null or r.id=$4::uuid)
    ) select h.id,h.source,h.kind,h.rank,
      to_char(h.event_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
      h.actor_id as "actorId",u.name as "actorName",h.reservation_id as "reservationId",
      h.before_status as "beforeStatus",h.after_status as "afterStatus",h.before_expiry as "beforeExpiry",
      h.after_expiry as "afterExpiry",h.reservation_version as "reservationVersion",h.unit_version as "unitVersion",
      h.task_id as "taskId",h.source_reference as "sourceReference"
    from history h left join workspace_users u on u.workspace_id=$1::uuid and u.id=h.actor_id
    where ($5::timestamptz is null or (h.event_at,h.rank,h.id)<($5::timestamptz,$6::int,$7::uuid))
    order by h.event_at desc,h.rank desc,h.id desc limit ${pageSize + 1}`,
    [fresh.workspaceId, scope.projectId, scope.unitId, scope.reservationId, cursor?.at ?? null, cursor?.rank ?? null, cursor?.id ?? null]);
    const visible = rows.slice(0, pageSize);
    const items: PropertySalesHistoryItem[] = visible.map(row => ({
      id: row.id, source: row.source, kind: row.kind, occurredAt: row.at,
      actor: { id: row.actorId, name: text(row.actorName, 200) }, unitId: scope.unitId, reservationId: row.reservationId,
      status: { before: status(row.beforeStatus, row.source), after: status(row.afterStatus, row.source) },
      expiresAt: { before: instant(row.beforeExpiry), after: instant(row.afterExpiry) },
      reservationVersion: version(row.reservationVersion), unitVersion: version(row.unitVersion),
      taskId: row.taskId, sourceReference: text(row.sourceReference, 2000),
    }));
    const last = visible.at(-1);
    return { ...scope, items, coverage: "RECORDED_EVENTS_ONLY", nextCursor: rows.length > pageSize && last
      ? Buffer.from(JSON.stringify({ ...scope, v: 1, at: last.at, rank: last.rank, id: last.id } satisfies Cursor)).toString("base64url") : null };
  }, options);
}
