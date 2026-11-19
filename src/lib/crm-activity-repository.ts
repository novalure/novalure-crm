import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { canViewAllWorkspaceContacts, canWriteContacts, getContactVisibilityScope } from "@/lib/contact-access";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { recordAutomationEvent } from "@/lib/automation/repository";
import { parseCrmActivityInput, type CrmActivityInput, type CrmActivityItem, type CrmActivityPage, type CrmActivityScope } from "@/lib/crm-activity";

type ResolvedScope = { contactId: string; leadId: string | null; projectId: string | null; canRecord: boolean };
type ActivityRow = { id: string; contactId: string; leadId: string | null; projectId: string | null; activityKind: string | null; source: string | null; channel: string; title: string; detail: string; outcome: string; occurredAt: string | Date; actorName: string | null };
const pageSize = 40;

async function activityScope(tx: TenantTransaction, session: AppSession, input: CrmActivityScope, write = false): Promise<ResolvedScope> {
  if (session.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Eine persönliche Anmeldung ist erforderlich.", 403);
  let contactId = input.contactId ? assertCrmUuid(input.contactId, "contactId") : null;
  const leadId = input.leadId ? assertCrmUuid(input.leadId, "leadId") : null;
  let projectId = input.projectId ? assertCrmUuid(input.projectId, "projectId") : null;
  if (!contactId && !leadId) throw new CrmCommandError("INVALID_SCOPE", "Kontakt oder Lead ist erforderlich.");
  if (leadId) {
    const lead = await tx.queryOne<{ contactId: string | null; projectId: string | null }>("select contact_id as \"contactId\",project_id as \"projectId\" from leads where workspace_id=$1::uuid and id=$2::uuid", [session.workspaceId, leadId]);
    if (!lead?.contactId || (contactId && contactId !== lead.contactId) || (projectId && projectId !== lead.projectId)) throw new CrmCommandError("ACTIVITY_NOT_AVAILABLE", "Die Aktivität ist für diesen Bezug nicht verfügbar.", 404);
    contactId = lead.contactId; projectId = lead.projectId;
  }
  const contact = await tx.queryOne<{ id: string; ownerUserId: string | null; projectId: string | null }>("select id,owner_user_id as \"ownerUserId\",project_id as \"projectId\" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null", [session.workspaceId, contactId]);
  const visibility = getContactVisibilityScope(session);
  if (!contact || visibility.kind === "none" || (visibility.kind === "own" && contact.ownerUserId !== visibility.userId)) throw new CrmCommandError("ACTIVITY_NOT_AVAILABLE", "Die Aktivität ist für diesen Kontakt nicht verfügbar.", 404);
  if (!leadId && projectId && contact.projectId && projectId !== contact.projectId) throw new CrmCommandError("ACTIVITY_NOT_AVAILABLE", "Kontakt und Projekt passen nicht zusammen.", 404);
  projectId = projectId ?? contact.projectId;
  if (projectId) await assertProjectGrant(tx, session, projectId, write);
  const canWriteProject = projectId ? (await tx.queryOne<{ allowed: boolean }>("select crm_project_access($1::uuid,$2::uuid,true) as allowed", [session.workspaceId, projectId]))?.allowed === true : canViewAllWorkspaceContacts(session);
  const canRecord = session.permissions.includes("crm:write") && canWriteContacts(session) && canWriteProject;
  if (write && !canRecord) throw new CrmCommandError("FORBIDDEN", "Eine Aktivität darf hier nicht erfasst werden.", 403);
  return { contactId: contact.id, leadId, projectId, canRecord };
}

function item(row: ActivityRow): CrmActivityItem {
  const kind = row.source === "crm_activity_manual" && ["note", "call_attempt", "call_connected"].includes(row.activityKind ?? "") ? row.activityKind as CrmActivityItem["kind"] : row.channel === "Notiz" ? "note" : row.source === "web_expose" ? "inquiry" : "record";
  return { id: row.id, contactId: row.contactId, leadId: row.leadId, projectId: row.projectId, kind, channel: row.channel, title: row.title, detail: row.detail, outcome: row.outcome, occurredAt: typeof row.occurredAt === "string" ? row.occurredAt : row.occurredAt.toISOString(), actorName: row.actorName, evidence: ["crm_activity_manual", "crm_notes"].includes(row.source ?? "") ? "manual" : "record" };
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    if (value.length > 300 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (!parsed || typeof parsed.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return { at: parsed.at, id: assertCrmUuid(parsed.id) };
  } catch { throw new CrmCommandError("INVALID_CURSOR", "Die Seitenmarkierung ist ungültig."); }
}

export async function readCrmActivity(session: AppSession, input: CrmActivityScope & { cursor?: string }, options: TenantTransactionOptions = {}): Promise<CrmActivityPage> {
  const cursor = decodeCursor(input.cursor);
  return withCrmRead(session, async (tx, fresh) => {
    const scope = await activityScope(tx, fresh, input);
    const rows = await tx.query<ActivityRow>(`
      select t.id,t.contact_id as "contactId",nullif(t.metadata->>'leadId','') as "leadId",t.project_id as "projectId",
        t.metadata->>'activityKind' as "activityKind",t.metadata->>'source' as source,t.channel,t.title,t.detail,t.outcome,to_char(t.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt",u.name as "actorName"
      from contact_timeline_items t left join workspace_users u on u.workspace_id=t.workspace_id
        and u.id::text=coalesce(t.metadata->>'actorUserId',t.metadata->>'createdByUserId',t.metadata->>'updatedByUserId')
      where t.workspace_id=$1::uuid and t.contact_id=$2::uuid
        and ($3::uuid is null or t.metadata->>'leadId'=$3::text or (nullif(t.metadata->>'leadId','') is null and t.channel='Notiz'))
        and (t.project_id is not distinct from $4::uuid or (t.project_id is null and t.channel='Notiz'))
        and ($5::timestamptz is null or (t.occurred_at,t.id)<($5::timestamptz,$6::uuid))
      order by t.occurred_at desc,t.id desc limit ${pageSize + 1}`, [fresh.workspaceId, scope.contactId, scope.leadId, scope.projectId, cursor?.at ?? null, cursor?.id ?? null]);
    const items = rows.slice(0, pageSize).map(item), last = items.at(-1);
    return { workspaceId: fresh.workspaceId, ...scope, items, nextCursor: rows.length > pageSize && last ? Buffer.from(JSON.stringify({ at: last.occurredAt, id: last.id })).toString("base64url") : null, source: "database" };
  }, options);
}

export async function recordCrmActivity(session: AppSession, value: CrmActivityInput, metadata: { idempotencyKey: string; correlationId: string }, options: TenantTransactionOptions = {}) {
  const input = parseCrmActivityInput(value);
  if (input.occurredAt && Date.parse(input.occurredAt) > Date.now() + 60000) throw new CrmCommandError("INVALID_TIME", "Eine abgeschlossene Aktivität kann nicht in der Zukunft liegen.");
  return withCrmRead(session, async (tx, fresh) => {
    const scope = await activityScope(tx, fresh, input, true);
    return executeCrmCommand(fresh, { operation: `crm.activity.${input.kind}`, resourceId: scope.contactId, projectId: scope.projectId ?? undefined, capability: "workspace:operate", ...metadata, payload: input }, async (commandTx, context) => {
      const active = await activityScope(commandTx, context.session, input, true);
      const id = randomUUID(), occurredAt = input.occurredAt ?? new Date().toISOString();
      const title = input.title ?? (input.kind === "note" ? "Notiz" : input.kind === "call_attempt" ? "Kontaktversuch manuell erfasst" : "Telefonat manuell erfasst");
      const channel = input.kind === "note" ? "Notiz" : "Telefon", outcome = input.kind === "call_attempt" ? "offen" : input.kind === "call_connected" ? "erledigt" : "info";
      const row = await commandTx.queryOne<ActivityRow>(`
        insert into contact_timeline_items(id,workspace_id,contact_id,project_id,channel,title,detail,outcome,occurred_at,metadata)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::timestamptz,$10::jsonb)
        returning id,contact_id as "contactId",project_id as "projectId",metadata->>'leadId' as "leadId",metadata->>'activityKind' as "activityKind",metadata->>'source' as source,channel,title,detail,outcome,to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt",$11::text as "actorName"`, [id, context.workspaceId, active.contactId, active.projectId, channel, title, input.detail, outcome, occurredAt, JSON.stringify({ leadId: active.leadId, activityKind: input.kind, source: "crm_activity_manual", actorUserId: context.actorId, commandId: context.commandId, manualEntry: true, deliveryVerified: false }), context.session.name]);
      if (!row) throw new CrmCommandError("ACTIVITY_UNCONFIRMED", "Die Aktivität konnte nicht gespeichert werden.", 503);
      let automationSignalRecorded = false;
      if (input.kind === "call_connected" && active.leadId) {
        const bridge = await commandTx.queryOne<{ present: boolean }>("select to_regclass('public.crm_automation_events') is not null as present");
        if (bridge?.present) {
          await recordAutomationEvent(commandTx, { workspaceId: context.workspaceId, projectId: active.projectId, leadId: active.leadId, eventId: `activity:${id}`, trigger: "personal_contact", occurredAt }, { enroll: false });
          automationSignalRecorded = true;
        }
      }
      return { persisted: true, item: item(row), automationSignalRecorded, externalSend: false };
    }, options);
  }, options);
}
