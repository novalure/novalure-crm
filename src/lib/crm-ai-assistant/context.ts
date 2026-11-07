import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertProjectGrant, crmPayloadDigest, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import type { AssistantRequest, AssistantSnapshot, AssistantSource } from "./contracts";
import { assertAssistantSession } from "./policy";

type Fact = { id: string; projectId: string | null; label: string; facts: Record<string, unknown> };
export type AssistantContext = {
  authority: string; sources: AssistantSource[]; capturedAt: string; recipient: string | null;
  snapshot: Omit<AssistantSnapshot, "credits" | "recentRuns">;
  facts: Record<string, unknown>;
};
const closedLeads = "('gewonnen','verloren','archiviert','abgeschlossen','closed','converted','disqualifiziert')";
const closedTasks = "('done','completed','erledigt','abgeschlossen','cancelled','abgebrochen')";
const closedDeals = "('gewonnen','verloren','disqualifiziert','abschluss','closed','won','lost')";

const modules: Record<string, string> = { l: "leadInbox", t: "tasks", e: "calendar", d: "pipeline", p: "properties" };
function access(alias: string, module = modules[alias]) {
  return `${alias}.workspace_id=$1::uuid and ($2::uuid is null or ${alias}.project_id=$2::uuid) and
    ((${alias}.project_id is null and crm_workspace_manager($1::uuid)) or (${alias}.project_id is not null and crm_project_access($1::uuid,${alias}.project_id,false)))
    ${module ? `and not exists(select 1 from workspace_module_settings ms where ms.workspace_id=$1::uuid and ms.module_key='${module}' and not ms.enabled)` : ""}
    ${["l", "t", "e", "d"].includes(alias) ? `and (${alias}.metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true'` : ""}`;
}
export async function assistantAuthority(tx: TenantTransaction, session: AppSession, projectId?: string) {
  assertAssistantSession(session);
  if (projectId) await assertProjectGrant(tx, session, projectId);
  const row = await tx.queryOne<{ ids: string[] }>(`select coalesce(array_agg(id order by id),'{}'::uuid[]) as ids from projects where workspace_id=$1::uuid and ($2::uuid is null or id=$2::uuid) and crm_project_access($1::uuid,id,false)`, [session.workspaceId, projectId ?? null]);
  const disabled = await tx.query<{ module_key: string }>("select module_key from workspace_module_settings where workspace_id=$1::uuid and not enabled order by module_key", [session.workspaceId]);
  return crmPayloadDigest({ role: session.role, productRole: session.productRole, permissions: session.permissions, productPermissions: session.productPermissions, projects: row?.ids ?? [], projectId: projectId ?? null, disabled });
}
export async function sourcesStillAllowed(tx: TenantTransaction, session: AppSession, sources: AssistantSource[]) {
  const tables: Record<AssistantSource["type"], string> = { lead: "leads", contact: "contacts", task: "tasks", meeting: "calendar_events", deal: "deals", property: "seller_listings", project: "projects" };
  for (const [type, table] of Object.entries(tables)) {
    const ids = [...new Set(sources.filter(source => source.type === type).map(source => source.id))];
    if (!ids.length) continue;
    const sourceModules: Record<string, string> = { lead: "leadInbox", contact: "contacts", task: "tasks", meeting: "calendar", deal: "pipeline", property: "properties" };
    const scope = type === "project" ? "r.workspace_id=$1::uuid and ($2::uuid is null or r.id=$2::uuid) and crm_project_access($1::uuid,r.id,false)" : access("r", sourceModules[type]);
    const archive = type === "contact" ? " and r.archived_at is null" : "";
    const own = type === "contact" && !canViewAllWorkspaceContacts(session) ? " and r.owner_user_id=$4::uuid" : "";
    const rows = await tx.query<{ id: string }>(`select r.id from ${table} r where ${scope} and r.id=any($3::uuid[])${archive}${own}`, [session.workspaceId, null, ids, ...(own ? [session.userId] : [])]);
    if (rows.length !== ids.length) return false;
  }
  return true;
}

export async function loadAssistantContext(tx: TenantTransaction, fresh: AppSession, input: AssistantRequest): Promise<AssistantContext> {
  assertAssistantSession(fresh, input.mode);
  const authority = await assistantAuthority(tx, fresh, input.projectId);
  const settings = await tx.query<{ module_key: string }>("select module_key from workspace_module_settings where workspace_id=$1::uuid and not enabled", [fresh.workspaceId]);
  const disabled = new Set(settings.map(row => row.module_key));
  if (disabled.has("bots")) throw new CrmCommandError("AI_ASSISTANT_FORBIDDEN", "The assistant is disabled for this company", 403);
  const analyticsAllowed = fresh.productPermissions.includes("analytics:read") && !disabled.has("analytics") && !disabled.has("pipeline");
  if (input.mode === "pipeline_analysis" && !analyticsAllowed) throw new CrmCommandError("AI_ASSISTANT_FORBIDDEN", "Analytics access is required", 403);
  const params = [fresh.workspaceId, input.projectId ?? null];
  const ownContacts = !canViewAllWorkspaceContacts(fresh);
  const personal = input.mode === "daily_briefing";
  const selectedLead = input.leadId ?? null, selectedProperty = input.propertyId ?? null;
  const timeZone = input.timeZone ?? "UTC";
  const leadRows = await tx.query<Fact & { recipient: string | null; contactId: string | null }>(`
    select l.id,l.project_id as "projectId",coalesce(nullif(c.name,''),nullif(left(l.intent,70),''),l.type) as label,c.email as recipient,c.id as "contactId",
    jsonb_build_object('contactName',c.name,'type',l.type,'status',l.status,'intent',left(l.intent,1000),'budget',l.budget,'nextAction',left(l.next_action,600),
      'receivedAt',l.received_at,'lastContactAt',l.last_contact_at,'nextContactAt',l.next_contact_at,'replyDueAt',l.sla_due_at,'region',l.region,'objectType',l.object_type) as facts
    from leads l left join contacts c on c.workspace_id=l.workspace_id and c.id=l.contact_id and c.archived_at is null and ($3::boolean or c.owner_user_id=$4::uuid)
      and not exists(select 1 from workspace_module_settings ms where ms.workspace_id=$1::uuid and ms.module_key='contacts' and not ms.enabled)
    where ${access("l")} and ($5::uuid is null or l.id=$5::uuid)
    and (not $6::boolean or l.assigned_to_user_id=$4::uuid or l.assigned_to_user_id is null)
    order by l.sla_due_at asc nulls last,l.received_at desc limit 101`, [...params, !ownContacts, fresh.userId, selectedLead, personal]);
  if (selectedLead && !leadRows.length) throw new CrmCommandError("AI_CONTEXT_FORBIDDEN", "The selected enquiry is unavailable in this scope", 403);
  const propertyRows = await tx.query<Fact>(`select p.id,p.project_id as "projectId",p.title as label,
    jsonb_build_object('title',p.title,'address',p.address,'region',p.region,'objectType',p.object_type,'areaSqm',p.area_sqm,'rooms',p.rooms,'yearBuilt',p.year_built,'askingPriceCents',nullif(p.target_price_cents,0),'currency','EUR') as facts
    from seller_listings p where ${access("p")} and ($3::uuid is null or p.id=$3::uuid) order by p.updated_at desc limit 101`, [...params, selectedProperty]);
  if (selectedProperty && !propertyRows.length) throw new CrmCommandError("AI_CONTEXT_FORBIDDEN", "The selected property is unavailable in this scope", 403);
  const contextLead = selectedLead ? leadRows[0] : null;
  const [tasks, meetings, deals, metrics, scopeRow] = await Promise.all([
    tx.query<Fact>(`select t.id,t.project_id as "projectId",t.title as label,jsonb_build_object('title',t.title,'dueAt',t.due_at,'priority',t.priority,'status',t.status,'leadId',t.lead_id) as facts
      from tasks t where ${access("t")} and lower(t.status) not in ${closedTasks} and ($3::uuid is null or t.lead_id=$3::uuid or t.contact_id=$4::uuid)
      and (not $5::boolean or t.owner_user_id=$6::uuid or t.owner_user_id is null) order by t.due_at asc nulls last,t.created_at desc limit 12`, [...params, selectedLead, contextLead?.contactId ?? null, personal, fresh.userId]),
    tx.query<Fact>(`select e.id,e.project_id as "projectId",e.title as label,jsonb_build_object('title',e.title,'startsAt',e.starts_at,'endsAt',e.ends_at,'location',e.location,'status',e.status,'goal',left(e.outcome_goal,500)) as facts
      from calendar_events e where ${access("e")} and lower(e.status) not in('abgesagt','cancelled','canceled') and e.starts_at>=now()-interval '1 day' and e.starts_at<now()+interval '8 days'
      and ($3::uuid is null or e.lead_id=$3::uuid or e.contact_id=$4::uuid) and (not $5::boolean or e.owner_user_id=$6::uuid or e.owner_user_id is null) order by e.starts_at limit 8`, [...params, selectedLead, contextLead?.contactId ?? null, personal, fresh.userId]),
    analyticsAllowed ? tx.query<Fact>(`select d.id,d.project_id as "projectId",d.name as label,jsonb_build_object('name',d.name,'stage',d.stage,'valueCents',d.value_cents,'currency','EUR','expectedCloseDate',d.expected_close_date,'nextAction',left(d.next_action,600),'updatedAt',d.updated_at) as facts
      from deals d where ${access("d")} and d.closed_at is null and d.lost_at is null and lower(d.stage) not in ${closedDeals} and ($3::uuid is null or d.lead_id=$3::uuid) order by d.updated_at asc limit 12`, [...params, selectedLead]) : Promise.resolve([] as Fact[]),
    tx.queryOne<AssistantSnapshot["metrics"]>(`select
      (select count(*)::int from leads l where ${access("l")} and lower(l.status) not in ${closedLeads}) as "openLeads",
      (select count(*)::int from tasks t where ${access("t")} and lower(t.status) not in ${closedTasks} and t.due_at<now() and(t.owner_user_id=$3::uuid or t.owner_user_id is null)) as "overdueTasks",
      (select count(*)::int from calendar_events e where ${access("e")} and lower(e.status) not in('abgesagt','cancelled','canceled') and (e.starts_at at time zone $4)::date=(now() at time zone $4)::date and(e.owner_user_id=$3::uuid or e.owner_user_id is null)) as "todayMeetings",
      case when $5::boolean then (select coalesce(sum(d.value_cents),0)::text from deals d where ${access("d")} and d.closed_at is null and d.lost_at is null and lower(d.stage) not in ${closedDeals}) else '0' end as "pipelineValueCents"`, [...params, fresh.userId, timeZone, analyticsAllowed]),
    input.projectId ? tx.queryOne<{ name: string }>("select name from projects where workspace_id=$1::uuid and id=$2::uuid", params) : Promise.resolve(null),
  ]);
  const sources: AssistantSource[] = [];
  const facts: Record<string, unknown> = {};
  function include(type: AssistantSource["type"], rows: Fact[], limit: number) {
    facts[type] = rows.slice(0, limit).map(row => {
      sources.push({ type, id: row.id, label: row.label.slice(0, 160) });
      if (type === "lead" && "contactId" in row && typeof row.contactId === "string") sources.push({ type: "contact", id: row.contactId, label: row.label.slice(0, 160) });
      return { sourceId: row.id, ...row.facts };
    });
  }
  if (input.mode === "property_text") include("property", propertyRows, 1);
  else {
    include("lead", leadRows, selectedLead ? 1 : 8); include("task", tasks, 10); include("meeting", meetings, 6);
    if (["pipeline_analysis", "crm_question", "lead_summary"].includes(input.mode)) include("deal", deals, 10);
    if (selectedProperty || input.mode === "crm_question") include("property", propertyRows, selectedProperty ? 1 : 5);
  }
  if (contextLead?.contactId) {
    sources.push({ type: "contact", id: contextLead.contactId, label: contextLead.label });
    const interactions = await tx.query<{ title: string; detail: string; occurredAt: string }>(`select left(title,180) as title,left(detail,800) as detail,occurred_at as "occurredAt" from contact_timeline_items t where ${access("t", "communication")} and t.contact_id=$3::uuid order by t.occurred_at desc limit 5`, [...params, contextLead.contactId]);
    facts.recentInteractions = interactions;
  }
  const capturedAt = new Date().toISOString();
  const cleanMetrics = { openLeads: Number(metrics?.openLeads ?? 0), overdueTasks: Number(metrics?.overdueTasks ?? 0), todayMeetings: Number(metrics?.todayMeetings ?? 0), pipelineValueCents: Number(metrics?.pipelineValueCents ?? 0) };
  if (!Number.isSafeInteger(cleanMetrics.pipelineValueCents)) throw new CrmCommandError("AI_CONTEXT_UNAVAILABLE", "The pipeline total is outside the supported range", 503);
  const snapshot: AssistantContext["snapshot"] = { source: "database", workspaceId: fresh.workspaceId, capturedAt, timeZone,
    scope: { projectId: input.projectId ?? null, label: scopeRow?.name ?? (input.language === "de" ? "Alle zugänglichen Projekte" : input.language === "es" ? "Todos los proyectos accesibles" : "All accessible projects") },
    options: { leads: leadRows.slice(0, 100).map(row => ({ id: row.id, label: row.label })), properties: propertyRows.slice(0, 100).map(row => ({ id: row.id, label: row.label })) },
    metrics: cleanMetrics, contextLimited: true, allowedModes: ["daily_briefing", ...(analyticsAllowed ? ["pipeline_analysis" as const] : []), ...(!disabled.has("leadInbox") ? ["lead_summary" as const] : []), "email_draft", ...(!disabled.has("properties") ? ["property_text" as const] : []), "crm_question"] };
  return { authority, sources: [...new Map(sources.map(source => [`${source.type}:${source.id}`, source])).values()], capturedAt, recipient: contextLead?.recipient ?? null, snapshot,
    facts: { scope: snapshot.scope.label, capturedAt, timeZone, metrics: cleanMetrics, coverage: "Metrics count all accessible records. Detail records are a limited selection, not the complete workspace. Tasks/meetings in daily briefing belong to the actor or are unassigned. No access to personal email inboxes.", ...facts } };
}
