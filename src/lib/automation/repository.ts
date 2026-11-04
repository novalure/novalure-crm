import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { upsertLeadRecord, upsertTaskRecord } from "@/lib/db/crm-write-repositories";
import { evaluateOutboundConsent } from "@/lib/db/consent-policy";
import {leadMatchAlgorithmVersion} from '@/lib/lead-qualification-matching';
import {leadPurchaseWindowExpired} from '@/lib/lead-qualification-plan';
import { automationStopReason, automationTriggers, evaluateAutomationCondition, nextAutomationBusinessTime, nextAutomationNode, validateAutomationGraph, type AutomationFacts, type AutomationGraph, type AutomationSignal } from "./graph";

export type AutomationRecord = { id: string; name: string; projectId: string | null; draft: AutomationGraph; revision: number; activeVersion: number | null; status: "draft" | "active" | "paused"; updatedAt: string; scheduleGranted?: boolean; scheduleActorId?: string | null; scheduleReady?: boolean; scheduleReason?: string };
export type AutomationEnrollment = { id: string; automationId: string; automationName: string; version: number; leadId: string; leadLabel: string; nodeId: string; nodeTitle: string; status: string; dueAt: string; stopReason: string | null; enrolledAt: string };
export type AutomationDraft = { id: string; enrollmentId: string; leadId: string; nodeId: string; subject: string; body: string; status: string; consentAllowed: boolean; consentReason: string; createdAt: string };
export type AutomationEventInput = { workspaceId: string; projectId: string | null; leadId: string; eventId: string; trigger: AutomationSignal; occurredAt?: string; context?: { exposeVersionId?: string; exposeSessionId?: string; identityLevel?: "intended_recipient"; unitId?: string; viewingId?: string; viewingVersion?: number; matchScore?: number; matchId?: string; proofId?: string; searchProfileCompleted?: boolean; proofAccepted?: boolean } };
export type RuntimeRow = { id: string; workspaceId: string; projectId: string | null; automationId: string; version: number; leadId: string; nodeId: string; enrolledAt: string | Date; graph: AutomationGraph; automationStatus: string };

async function scope(tx: TenantTransaction, session: AppSession, projectId: string | null, write: boolean) {
  if (projectId) await assertProjectGrant(tx, session, projectId, write);
  else if (!(await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [session.workspaceId]))?.allowed) throw new CrmCommandError("PROJECT_REQUIRED", "Ein berechtigtes Projekt ist erforderlich.", 403);
}
export async function listAutomations(session: AppSession, projectId?: string | null, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    if (projectId) await scope(tx, fresh, projectId, false);
    const values = [fresh.workspaceId, projectId || null];
    const definitions = await tx.query<AutomationRecord>(`select id,name,project_id as "projectId",draft,revision,active_version as "activeVersion",status,updated_at as "updatedAt",schedule_actor_id as "scheduleActorId",(schedule_version=active_version and schedule_identity_id is not null) as "scheduleGranted" from crm_automations where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid or project_id is null) order by updated_at desc limit 100`, values);
    const enrollments = await tx.query<AutomationEnrollment>(`select e.id,e.automation_id as "automationId",a.name as "automationName",e.version,e.lead_id as "leadId",coalesce(nullif(l.intent,''),'Anfrage') as "leadLabel",e.node_id as "nodeId",(select n->>'title' from jsonb_array_elements(v.graph->'nodes') n where n->>'id'=e.node_id limit 1) as "nodeTitle",e.status,e.due_at as "dueAt",e.stop_reason as "stopReason",e.enrolled_at as "enrolledAt" from crm_automation_enrollments e join crm_automations a on a.workspace_id=e.workspace_id and a.id=e.automation_id join crm_automation_versions v on v.workspace_id=e.workspace_id and v.automation_id=e.automation_id and v.version=e.version join leads l on l.workspace_id=e.workspace_id and l.id=e.lead_id where e.workspace_id=$1::uuid and ($2::uuid is null or e.project_id=$2::uuid) order by e.updated_at desc limit 100`, values);
    const drafts = await tx.query<AutomationDraft>(`select d.id,d.enrollment_id as "enrollmentId",e.lead_id as "leadId",d.node_id as "nodeId",d.subject,d.body,d.status,d.consent_allowed as "consentAllowed",d.consent_reason as "consentReason",d.created_at as "createdAt" from crm_automation_drafts d join crm_automation_enrollments e on e.id=d.enrollment_id and e.workspace_id=d.workspace_id where d.workspace_id=$1::uuid and e.lead_id is not null and ($2::uuid is null or d.project_id=$2::uuid) order by d.created_at desc limit 100`, values);
    return { definitions, enrollments, drafts, source: "database" as const };
  }, options);
}
export async function saveAutomation(tx: TenantTransaction, session: AppSession, input: { id?: string; projectId: string | null; name: string; graph: unknown; expectedRevision?: number }) {
  await scope(tx, session, input.projectId, true);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 200) throw new CrmCommandError("INVALID_NAME", "Ein Name mit höchstens 200 Zeichen ist erforderlich.");
  const graph = validateAutomationGraph(input.graph);
  if (!input.id) return (await tx.queryOne<AutomationRecord>(`insert into crm_automations(workspace_id,project_id,name,draft,created_by) values($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid) returning id,name,project_id as "projectId",draft,revision,active_version as "activeVersion",status,updated_at as "updatedAt"`, [session.workspaceId, input.projectId, name, JSON.stringify(graph), session.userId]))!;
  assertCrmUuid(input.id);
  const prior = await tx.queryOne<{ projectId: string | null }>(`select project_id as "projectId" from crm_automations where id=$1::uuid and workspace_id=$2::uuid for update`, [input.id, session.workspaceId]);
  if (!prior) throw new CrmCommandError("NOT_FOUND", "Flow ist nicht verfügbar.", 404);
  if (prior.projectId !== input.projectId) throw new CrmCommandError("SCOPE_IMMUTABLE", "Der Projektbezug eines gespeicherten Flows kann nicht geändert werden.");
  const saved = await tx.queryOne<AutomationRecord>(`update crm_automations set name=$3,draft=$4::jsonb,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and revision=$5 returning id,name,project_id as "projectId",draft,revision,active_version as "activeVersion",status,updated_at as "updatedAt"`, [input.id, session.workspaceId, name, JSON.stringify(graph), input.expectedRevision]);
  if (!saved) throw new CrmCommandError("VERSION_CONFLICT", "Der Flow wurde zwischenzeitlich geändert. Bitte neu laden.", 409);
  return saved;
}
export async function setAutomationStatus(tx: TenantTransaction, session: AppSession, input: { id: string; expectedRevision: number; active: boolean }) {
  const row = await tx.queryOne<AutomationRecord>(`select id,name,project_id as "projectId",draft,revision,active_version as "activeVersion",status,updated_at as "updatedAt" from crm_automations where id=$1::uuid and workspace_id=$2::uuid for update`, [assertCrmUuid(input.id), session.workspaceId]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Flow ist nicht verfügbar.", 404);
  await scope(tx, session, row.projectId, true);
  if (row.revision !== input.expectedRevision) throw new CrmCommandError("VERSION_CONFLICT", "Der Flow wurde geändert. Bitte neu laden.", 409);
  let version = row.activeVersion;
  if (input.active) {
    const graph = validateAutomationGraph(row.draft);
    const latest = await tx.queryOne<{ version: number }>(`select coalesce(max(version),0)+1 as version from crm_automation_versions where workspace_id=$1::uuid and automation_id=$2::uuid`, [session.workspaceId, row.id]);
    version = latest!.version;
    await tx.execute(`insert into crm_automation_versions(workspace_id,project_id,automation_id,version,graph,graph_digest,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7::uuid)`, [session.workspaceId, row.projectId, row.id, version, JSON.stringify(graph), crmPayloadDigest(graph), session.userId]);
  }
  let identity: string | null = null;
  if (input.active && session.source === "cookie" && !session.serviceIdentity && session.authSessionId && session.authIdentityId) {
    const proof = await tx.queryOne<{ valid: boolean }>(`select exists(select 1 from auth_sessions s join auth_identities i on i.id=s.auth_identity_id where s.id=$1::uuid and s.auth_identity_id=$2::uuid and s.workspace_id=$3::uuid and s.workspace_user_id=$4::uuid and s.revoked_at is null and s.expires_at>clock_timestamp() and s.mfa_verified_at is not null and i.credential_state='active' and i.disabled_at is null and i.mfa_enabled_at is not null) as valid`, [session.authSessionId, session.authIdentityId, session.workspaceId, session.userId]);
    if (proof?.valid) identity = session.authIdentityId;
  }
  await tx.execute(`update crm_automations set status=$3,active_version=$4,revision=revision+1,updated_at=now(),schedule_actor_id=$5::uuid,schedule_identity_id=$6::uuid,schedule_version=$7 where id=$1::uuid and workspace_id=$2::uuid`, [row.id, session.workspaceId, input.active ? "active" : "paused", version, identity ? session.userId : null, identity, identity ? version : null]);
  return { id: row.id, activeVersion: version, status: input.active ? "active" : "paused", revision: row.revision + 1, scheduleGranted: !!identity };
}

/** Trusted server ingress. Public client events must pass their own identity/consent controls first. */
export async function recordAutomationEvent(tx: TenantTransaction, input: AutomationEventInput, options: { enroll?: boolean; automationId?: string } = {}): Promise<{ eventId: string|null; enrolled: number; skipped?:string }> {
  assertCrmUuid(input.workspaceId); assertCrmUuid(input.leadId); if (input.projectId) assertCrmUuid(input.projectId);
  if (typeof input.eventId !== "string" || !input.eventId.trim() || input.eventId.length > 180 || ![...automationTriggers, "personal_contact", "reply_received", "opt_out", "manual_start", "proof_reviewed"].includes(input.trigger)) throw new CrmCommandError("INVALID_EVENT", "Automationsereignis ist ungültig.");
  const occurred = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (!Number.isFinite(occurred.getTime()) || occurred.getTime() > Date.now() + 60000) throw new CrmCommandError("INVALID_EVENT_TIME", "Ereigniszeitpunkt ist ungültig.");
  const lead = await tx.queryOne<{ projectId: string | null; syntheticExample:boolean }>(`select project_id as "projectId",coalesce(metadata#>>'{onboardingExample,synthetic}','false')='true' as "syntheticExample" from leads where workspace_id=$1::uuid and id=$2::uuid`, [input.workspaceId, input.leadId]);
  if (!lead || lead.projectId !== input.projectId) throw new CrmCommandError("EVENT_SCOPE_DENIED", "Ereignis und Lead gehören nicht zum selben berechtigten Projekt.", 403);
  if(lead.syntheticExample)return{eventId:null,enrolled:0,skipped:'synthetic_example'};
  const c = input.context ?? {}, context: NonNullable<AutomationEventInput["context"]> = {};
  if (c.exposeVersionId) context.exposeVersionId = assertCrmUuid(c.exposeVersionId);
  if (c.exposeSessionId) context.exposeSessionId = assertCrmUuid(c.exposeSessionId);
  if (c.identityLevel !== undefined) {
    if (c.identityLevel !== "intended_recipient") throw new CrmCommandError("IDENTITY_LEVEL_INVALID", "Ein persönlicher Link bestätigt keine Empfängeridentität.");
    context.identityLevel = "intended_recipient";
  }
  if (c.unitId) context.unitId = assertCrmUuid(c.unitId);
  if (c.viewingId) context.viewingId = assertCrmUuid(c.viewingId);
  if(c.viewingVersion!==undefined){if(!Number.isSafeInteger(c.viewingVersion)||c.viewingVersion<1)throw new CrmCommandError("INVALID_VIEWING_VERSION","Besichtigungsversion ist ungültig.");context.viewingVersion=c.viewingVersion;}
  if (c.proofId) context.proofId = assertCrmUuid(c.proofId);
  if (c.matchId) context.matchId = assertCrmUuid(c.matchId);
  if (c.matchScore !== undefined) {
    if (!Number.isFinite(c.matchScore) || c.matchScore < 0 || c.matchScore > 100) throw new CrmCommandError("INVALID_MATCH_SCORE", "Matchingwert ist ungültig.");
    context.matchScore = c.matchScore;
  }
  for (const key of ["searchProfileCompleted", "proofAccepted"] as const) if (typeof c[key] === "boolean") context[key] = c[key];
  const inserted = await tx.queryOne<{ id: string }>(`insert into crm_automation_events(workspace_id,project_id,lead_id,event_key,trigger_key,context,occurred_at) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::timestamptz) on conflict(workspace_id,event_key) do nothing returning id`, [input.workspaceId, input.projectId, input.leadId, input.eventId, input.trigger, JSON.stringify(context), occurred.toISOString()]);
  if (!inserted) {
    const prior = await tx.queryOne<{ id: string; leadId: string | null; trigger: string; context: object }>(`select id,lead_id as "leadId",trigger_key as trigger,context from crm_automation_events where workspace_id=$1::uuid and event_key=$2`, [input.workspaceId, input.eventId]);
    if(prior?.trigger==='tracking_erased')return{eventId:prior.id,enrolled:0};
    if (!prior || prior.leadId !== input.leadId || prior.trigger !== input.trigger || crmPayloadDigest(prior.context) !== crmPayloadDigest(context)) throw new CrmCommandError("EVENT_ID_CONFLICT", "Diese Ereignis-ID wurde bereits für andere Daten verwendet.", 409);
    return { eventId: prior.id, enrolled: options.enroll === false ? 0 : await admitPendingAutomationEvents(tx, input.workspaceId, input.projectId, options.automationId) };
  }
  if (["opt_out", "personal_contact", "reply_received"].includes(input.trigger)) {
    await tx.execute(`update crm_automation_enrollments e set status='stopped',stop_reason=$3,updated_at=now() from crm_automation_versions v where e.workspace_id=$1::uuid and e.lead_id=$2::uuid and e.status in('running','waiting','waiting_signal','review','blocked') and v.workspace_id=e.workspace_id and v.automation_id=e.automation_id and v.version=e.version and ($3='opt_out' or ((v.graph->>'stopOnPersonalContact')::boolean and e.enrolled_at<=$4::timestamptz))`, [input.workspaceId, input.leadId, input.trigger, occurred.toISOString()]);
    return { eventId: inserted.id, enrolled: 0 };
  }
  return { eventId: inserted.id, enrolled: options.enroll === false ? 0 : await admitPendingAutomationEvents(tx, input.workspaceId, input.projectId, options.automationId) };
}

/** Canonical events survive outbox consumption; each immutable version admits every event at most once. */
export async function admitPendingAutomationEvents(tx: TenantTransaction, workspaceId: string, projectId?: string | null, automationId?: string) {
  const definitions = await tx.query<{ id: string; version: number; graph: AutomationGraph }>(`select a.id,a.active_version as version,v.graph from crm_automations a join crm_automation_versions v on v.workspace_id=a.workspace_id and v.automation_id=a.id and v.version=a.active_version where a.workspace_id=$1::uuid and ($2::uuid is null or a.project_id is null or a.project_id=$2::uuid) and a.status='active' and ($3::uuid is null or a.id=$3::uuid)`, [workspaceId, projectId || null, automationId || null]);
  let enrolled = 0;
  for (const row of definitions) {
    const graph = validateAutomationGraph(row.graph, { allowLegacyVariables: true }), start = graph.nodes.find((n) => n.type === "start")!;
    const events = await tx.query<{ id: string; projectId: string | null; leadId: string; context:AutomationEventInput['context'] }>(`select e.id,e.project_id as "projectId",e.lead_id as "leadId",e.context from crm_automation_events e join crm_automation_versions v on v.workspace_id=e.workspace_id and v.automation_id=$2::uuid and v.version=$3 where e.workspace_id=$1::uuid and e.trigger_key=$4 and exists(select 1 from leads l where l.workspace_id=e.workspace_id and l.id=e.lead_id and coalesce(l.metadata#>>'{onboardingExample,synthetic}','false')<>'true') and e.occurred_at>=v.created_at and ($4<>'new_match' or (e.context->>'matchScore')::numeric>=80) and ($5::uuid is null or e.project_id=$5::uuid) and (v.project_id is null or e.project_id=v.project_id) and not exists(select 1 from crm_automation_admissions r where r.workspace_id=e.workspace_id and r.automation_id=v.automation_id and r.version=v.version and r.event_id=e.id) order by e.created_at,e.id limit 100`, [workspaceId, row.id, row.version, graph.trigger, projectId || null]);
    for (const event of events) {
      const allowed=graph.trigger!=='expose_opened'||!event.context?.exposeSessionId||await automationExposeSignalAllowed(tx,workspaceId,event.leadId,event.context);
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`automation-event:${workspaceId}:${event.id}`]);
      const current=await tx.queryOne<{leadId:string|null}>(`select lead_id as "leadId" from crm_automation_events where workspace_id=$1::uuid and id=$2::uuid and trigger_key=$3`,[workspaceId,event.id,graph.trigger]);
      if(!current?.leadId)continue;
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`automation-enrollment:${workspaceId}:${row.id}:${row.version}:${event.leadId}`]);
      if(await tx.queryOne(`select id from crm_automation_enrollments where workspace_id=$1::uuid and automation_id=$2::uuid and version=$3 and lead_id=$4::uuid and status in('running','waiting','waiting_signal','review','blocked')`,[workspaceId,row.id,row.version,event.leadId]))continue;
      const claim = await tx.queryOne(`insert into crm_automation_admissions(workspace_id,project_id,automation_id,version,event_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid) on conflict do nothing returning event_id`, [workspaceId, event.projectId, row.id, row.version, event.id]);
      if (!claim||!allowed) continue;
      const result = await tx.queryOne(`insert into crm_automation_enrollments(workspace_id,project_id,automation_id,version,lead_id,event_id,node_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7) on conflict do nothing returning id`, [workspaceId, event.projectId, row.id, row.version, event.leadId, event.id, start.id]);
      if (result) enrolled++;
    }
  }
  return enrolled;
}

/** Explicit intake of an existing lead; it is never recorded as a newly created lead. */
export async function enrollAutomationLead(tx: TenantTransaction, session: AppSession, input: { automationId: string; leadId: string; eventId: string }) {
  const row = await tx.queryOne<{ id: string; projectId: string | null; version: number; graph: AutomationGraph }>(`select a.id,a.project_id as "projectId",a.active_version as version,v.graph from crm_automations a join crm_automation_versions v on v.workspace_id=a.workspace_id and v.automation_id=a.id and v.version=a.active_version where a.workspace_id=$1::uuid and a.id=$2::uuid and a.status='active' for share of a`, [session.workspaceId, assertCrmUuid(input.automationId)]);
  if (!row) throw new CrmCommandError("FLOW_INACTIVE", "Nur ein aktivierter Flow kann bestehende Leads aufnehmen.", 409);
  const lead = await tx.queryOne<{ projectId: string | null }>(`select project_id as "projectId" from leads where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, assertCrmUuid(input.leadId)]);
  if (!lead || (row.projectId && row.projectId !== lead.projectId)) throw new CrmCommandError("LEAD_SCOPE_DENIED", "Lead ist für diesen Flow nicht berechtigt verfügbar.", 403);
  await scope(tx, session, lead.projectId, true);
  const event = await recordAutomationEvent(tx, { workspaceId: session.workspaceId, projectId: lead.projectId, leadId: input.leadId, eventId: input.eventId, trigger: "manual_start" });
  if(!event.eventId)throw new CrmCommandError('SYNTHETIC_EXAMPLE_ISOLATED','Beispieldaten können nicht in echte Automationen aufgenommen werden.',409);
  const graph = validateAutomationGraph(row.graph, { allowLegacyVariables: true }), start = graph.nodes.find((n) => n.type === "start")!;
  const enrolled = await tx.queryOne<{ id: string }>(`insert into crm_automation_enrollments(workspace_id,project_id,automation_id,version,lead_id,event_id,node_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7) on conflict do nothing returning id`, [session.workspaceId, lead.projectId, row.id, row.version, input.leadId, event.eventId, start.id]);
  return { enrolled: !!enrolled, enrollmentId: enrolled?.id ?? null };
}

export async function readRuntimeFacts(tx: TenantTransaction, run: RuntimeRow) {
  const lead = await tx.queryOne<{ version: number; contactId: string | null; assignedToUserId: string | null; phone: string | null; email: string | null; address: string | null; addressKnown: boolean; phase: string; inquiry: string; consentLabel: string | null; personalContact: boolean;syntheticExample:boolean }>(`select l.version,l.contact_id as "contactId",l.assigned_to_user_id as "assignedToUserId",c.phone,c.email,c.metadata->>'address' as address,(c.metadata ? 'address') as "addressKnown",l.status as phase,l.intent as inquiry,c.consent_label as "consentLabel",coalesce(l.metadata#>>'{onboardingExample,synthetic}','false')='true' as "syntheticExample",(l.last_contact_at is not null and l.last_contact_at>= $3::timestamptz) as "personalContact" from leads l left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where l.workspace_id=$1::uuid and l.id=$2::uuid for update of l`, [run.workspaceId, run.leadId, run.enrolledAt]);
  if (!lead) throw new CrmCommandError("LEAD_UNAVAILABLE", "Lead ist nicht mehr berechtigt verfügbar.", 403);
  lead.version = Number(lead.version);
  if (!Number.isSafeInteger(lead.version) || lead.version < 1) throw new CrmCommandError("LEAD_VERSION_INVALID", "Leadversion ist ungültig.", 409);
  const storedEvents = await tx.query<{ trigger: string; context: AutomationEventInput["context"]; occurredAt: string | Date }>(`select trigger_key as trigger,context,occurred_at as "occurredAt" from crm_automation_events where workspace_id=$1::uuid and lead_id=$2::uuid order by occurred_at desc,created_at desc limit 250`, [run.workspaceId, run.leadId]);
  const events: typeof storedEvents = [];
  for (const event of storedEvents) if (event.trigger !== "expose_opened" || !event.context?.exposeSessionId || await automationExposeSignalAllowed(tx, run.workspaceId, run.leadId, event.context)) events.push(event);
  const has = (trigger: string): true | null => events.some((e) => e.trigger === trigger) ? true : null;
  const recent = (trigger: string): true | null => events.some((e) => e.trigger === trigger && new Date(e.occurredAt).getTime() >= new Date(run.enrolledAt).getTime()) ? true : null;
  const latest = <K extends keyof NonNullable<AutomationEventInput["context"]>>(key: K) => events.find((e) => e.context?.[key] !== undefined)?.context?.[key];
  const consents = lead.contactId ? await tx.query<{ status: string }>(`select distinct on(channel) status from consent_records where workspace_id=$1::uuid and contact_id=$2::uuid and channel in('E-Mail','Newsletter') order by channel,captured_at desc,id desc`, [run.workspaceId, lead.contactId]) : [];
  const facts: AutomationFacts = { phone: lead.phone, address: lead.addressKnown ? lead.address : undefined, phase: lead.phase, inquiry: lead.inquiry,
    exposeOpened: has("expose_opened"), replied: recent("reply_received"), booked: has("appointment_booked"), proofAccepted: latest("proofAccepted") ?? null,
    searchProfileExists: latest("searchProfileCompleted") ?? has("search_profile_completed"), matchScore: latest("matchScore") ?? null,
    optedOut: has("opt_out") === true || [lead.consentLabel ?? "", ...consents.map((c) => c.status)].some((value) => /opt.?out|abgemeldet|unsubscribe|widerspruch/i.test(value)), personalContact: lead.personalContact || recent("personal_contact") === true };
  const currentViewing=await tx.queryOne<{known:boolean;booked:boolean}>(`select count(*)>0 as known,coalesce(bool_or(status in('confirmed','completed')),false) as booked from property_viewing_slots where workspace_id=$1::uuid and lead_id=$2::uuid`,[run.workspaceId,run.leadId]);
  if(currentViewing?.known)facts.booked=currentViewing.booked;
  const qualification = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.lead_qualification_proofs') is not null as installed");
  if (qualification?.installed) {
    const proofs = await tx.queryOne<{ known: boolean; accepted: boolean }>(`select count(*)>0 as known,coalesce(bool_or(status='accepted' and usable_until>clock_timestamp()),false) as accepted from lead_qualification_proofs where workspace_id=$1::uuid and lead_id=$2::uuid`, [run.workspaceId, run.leadId]);
    facts.proofAccepted = proofs?.known ? proofs.accepted : null;
    const matching = await tx.query<{ score: number; criteria:Parameters<typeof leadPurchaseWindowExpired>[0] }>(`select m.score,m.criteria_snapshot as criteria from lead_property_matches m join buyer_search_profiles b on b.id=m.profile_id and b.workspace_id=m.workspace_id join seller_listings p on p.id=m.property_id and p.workspace_id=m.workspace_id left join property_units u on u.id=p.unit_id and u.workspace_id=p.workspace_id where m.workspace_id=$1::uuid and m.lead_id=$2::uuid and m.eligible and m.algorithm_version=$3 and m.profile_updated_at=b.updated_at and m.property_updated_at=p.updated_at and coalesce(u.price_cents,p.target_price_cents)=(m.property_snapshot->>'priceCents')::bigint and p.property_status not in('archived','error','paused') and (u.id is null or u.status='available') order by m.score desc limit 501`, [run.workspaceId, run.leadId,leadMatchAlgorithmVersion]);
    facts.matchScore = matching.find(match=>!leadPurchaseWindowExpired(match.criteria))?.score ?? null;
  }
  return { lead, facts };
}

/** Analytics withdrawal invalidates only analytics-derived signals, never a separately submitted inquiry. */
export async function automationExposeSignalAllowed(tx: TenantTransaction, workspaceId: string, leadId: string, context?: AutomationEventInput["context"]) {
  if (!context?.exposeSessionId) return false;
  const installed = await tx.queryOne<{ ready: boolean }>("select to_regclass('public.web_expose_sessions') is not null as ready");
  if (!installed?.ready) return false;
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`web-expose-analytics-session:${context.exposeSessionId}`]);
  const linked = await tx.queryOne<{ linkId: string }>(`select link_id as "linkId" from web_expose_sessions where workspace_id=$1::uuid and id=$2::uuid`, [workspaceId, context.exposeSessionId]);
  if (!linked) return false;
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`web-expose-link:${linked.linkId}`]);
  const row = await tx.queryOne<{ allowed: boolean }>(`select exists(select 1 from web_expose_sessions s join web_expose_links l on l.id=s.link_id and l.workspace_id=s.workspace_id join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id where s.workspace_id=$1::uuid and s.id=$2::uuid and s.withdrawn_at is null and l.revoked_at is null and (l.expires_at is null or l.expires_at>clock_timestamp()) and v.active and l.intended_lead_id=$3::uuid) as allowed`, [workspaceId, assertCrmUuid(context.exposeSessionId), leadId]);
  return row?.allowed === true;
}
/** A cancellation or proposed reschedule invalidates the old confirmation before any dependent effect. */
export async function automationViewingSignalAllowed(tx:TenantTransaction,workspaceId:string,leadId:string,context?:AutomationEventInput['context']){
 if(!context?.viewingId)return false;
 const row=await tx.queryOne<{status:string;version:string|number}>(`select status,version from property_viewing_slots where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid for share`,[workspaceId,leadId,assertCrmUuid(context.viewingId)]);return !!row&&['confirmed','completed'].includes(row.status)&&(context.viewingVersion===undefined||Number(row.version)===context.viewingVersion);
}
export async function automationMatchSignalAllowed(tx:TenantTransaction,workspaceId:string,leadId:string,context?:AutomationEventInput['context']){
 if(!context?.matchId)return false;
 const row=await tx.queryOne<{criteria:Parameters<typeof leadPurchaseWindowExpired>[0]}>(`select m.criteria_snapshot as criteria from lead_property_matches m join buyer_search_profiles b on b.workspace_id=m.workspace_id and b.id=m.profile_id join seller_listings p on p.workspace_id=m.workspace_id and p.id=m.property_id left join property_units u on u.workspace_id=p.workspace_id and u.id=p.unit_id where m.workspace_id=$1::uuid and m.lead_id=$2::uuid and m.id=$3::uuid and m.eligible and m.score>=80 and m.algorithm_version=$4 and m.profile_updated_at=b.updated_at and m.property_updated_at=p.updated_at and coalesce(u.price_cents,p.target_price_cents)=(m.property_snapshot->>'priceCents')::bigint and p.property_status not in('archived','error','paused') and (u.id is null or u.status='available') for share of m,b,p`,[workspaceId,leadId,assertCrmUuid(context.matchId),leadMatchAlgorithmVersion]);return!!row&&!leadPurchaseWindowExpired(row.criteria);
}

/** Transactional effects only: row locks + atomic step record make retries safe; no external sends. */
export async function runAutomationDue(tx: TenantTransaction, session: AppSession, projectId?: string | null, limit = 20, automationId?: string) {
  if (projectId) await scope(tx, session, projectId, true);
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`web-expose-automation-workspace:${session.workspaceId}`]);
  const bounded = Math.max(1, Math.min(25, Number.isSafeInteger(limit) ? limit : 20));
  const matchingModule = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.lead_match_refresh_jobs') is not null as installed");
  if (matchingModule?.installed) { const { processLeadMatchRefreshJobs } = await import("@/lib/lead-qualification-repository"); await processLeadMatchRefreshJobs(tx, session, projectId); }
  // Check even future waits and review-held drafts: withdrawal must not depend on due_at.
  const analyticsRuns = await tx.query<{ id: string; leadId: string; context: AutomationEventInput["context"] }>(`select e.id,e.lead_id as "leadId",ev.context from crm_automation_enrollments e join crm_automation_events ev on ev.id=e.event_id and ev.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and ($2::uuid is null or e.project_id=$2::uuid) and ($3::uuid is null or e.automation_id=$3::uuid) and e.status in('running','waiting','waiting_signal','review','blocked') and ev.trigger_key='expose_opened' and ev.context ? 'exposeSessionId' order by e.id limit 100`, [session.workspaceId, projectId || null, automationId || null]);
  let revoked = 0;
  for (const run of analyticsRuns) if (!await automationExposeSignalAllowed(tx, session.workspaceId, run.leadId, run.context)) {
    await tx.execute(`update crm_automation_enrollments set status='stopped',stop_reason='analytics_permission_withdrawn',updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and lead_id is not null`, [session.workspaceId, run.id]); revoked++;
  }
  let ingested = 0;
  const bridge = await tx.queryOne<{ present: boolean }>("select to_regclass('public.web_expose_outbox') is not null as present");
  if (bridge?.present) {
    const outbox = await tx.query<{ id: string; workspaceId: string; projectId: string | null; leadId: string; trigger: AutomationSignal; occurredAt: string | Date; payload: AutomationEventInput["context"] }>(`select id,workspace_id as "workspaceId",project_id as "projectId",lead_id as "leadId",event_type as trigger,occurred_at as "occurredAt",payload from web_expose_outbox where workspace_id=$1::uuid and processed_at is null and ($2::uuid is null or project_id=$2::uuid) order by occurred_at,id for update skip locked limit 50`, [session.workspaceId, projectId || null]);
    for (const event of outbox) {
      if (event.projectId) await scope(tx, session, event.projectId, true);
      if (event.trigger !== "expose_opened" || await automationExposeSignalAllowed(tx, session.workspaceId, event.leadId, event.payload)) await recordAutomationEvent(tx, { ...event, eventId: event.id, context: event.payload, occurredAt: new Date(event.occurredAt).toISOString() }, { enroll: false });
      await tx.execute(`update web_expose_outbox set processed_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, event.id]);
      ingested++;
    }
  }
  await admitPendingAutomationEvents(tx, session.workspaceId, projectId, automationId);
  const runs = await tx.query<RuntimeRow>(`select e.id,e.workspace_id as "workspaceId",e.project_id as "projectId",e.automation_id as "automationId",e.version,e.lead_id as "leadId",e.node_id as "nodeId",e.enrolled_at as "enrolledAt",v.graph,a.status as "automationStatus" from crm_automation_enrollments e join crm_automation_versions v on v.workspace_id=e.workspace_id and v.automation_id=e.automation_id and v.version=e.version join crm_automations a on a.id=e.automation_id and a.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and ($2::uuid is null or e.project_id=$2::uuid) and ($4::uuid is null or e.automation_id=$4::uuid) and e.status in('running','waiting','waiting_signal') and e.due_at<=now() and a.status='active' order by e.due_at,e.id limit $3`, [session.workspaceId, projectId || null, bounded, automationId || null]);
  const outcomes: { id: string; status: string; reason?: string }[] = [];
  for (const run of runs) {
    await scope(tx, session, run.projectId, true);
    const graph = validateAutomationGraph(run.graph, { allowLegacyVariables: true });
    const origin = await tx.queryOne<{ trigger: string; context: AutomationEventInput["context"] }>(`select ev.trigger_key as trigger,ev.context from crm_automation_enrollments e join crm_automation_events ev on ev.id=e.event_id and ev.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and e.id=$2::uuid`, [session.workspaceId, run.id]);
    const revokedAnalytics = origin?.trigger === "expose_opened" && origin.context?.exposeSessionId && !await automationExposeSignalAllowed(tx, session.workspaceId, run.leadId, origin.context);
    const claimed=await tx.queryOne(`select e.id from crm_automation_enrollments e join crm_automations a on a.id=e.automation_id and a.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and e.id=$2::uuid and e.node_id=$3 and e.version=$4 and e.status in('running','waiting','waiting_signal') and e.due_at<=clock_timestamp() and a.status='active' for update of e skip locked for share of a`,[session.workspaceId,run.id,run.nodeId,run.version]);
    if(!claimed)continue;
    const {lead,facts}=await readRuntimeFacts(tx,run);
    const staleMatch=origin?.trigger==='new_match'&&origin.context?.matchId&&!await automationMatchSignalAllowed(tx,session.workspaceId,run.leadId,origin.context);
    const viewingChanged=origin?.trigger==='appointment_booked'&&origin.context?.viewingId&&!await automationViewingSignalAllowed(tx,session.workspaceId,run.leadId,origin.context);
    const stopped = lead.syntheticExample?'synthetic_example':revokedAnalytics ? "analytics_permission_withdrawn" : staleMatch ? "matching_changed" : viewingChanged?'viewing_changed':automationStopReason(graph, facts);
    if (stopped) {
      await tx.execute(`update crm_automation_enrollments set status='stopped',stop_reason=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, run.id, stopped]);
      outcomes.push({ id: run.id, status: "stopped", reason: stopped }); continue;
    }
    let nodeId: string | null = run.nodeId, status = "running", due = new Date(), reason: string | undefined;
    for (let count = 0; nodeId && count < 12; count++) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) throw new CrmCommandError("INVALID_RUNTIME_NODE", "Gespeicherter Schritt fehlt.", 409);
      if (["task", "phase", "email_draft", "request"].includes(node.type)) {
        due = nextAutomationBusinessTime(new Date(), graph);
        if (due.getTime() > Date.now()) { status = "waiting"; break; }
      }
      let port: "next" | "yes" | "no" = "next", result: Record<string, unknown> = {};
      if (node.type === "condition") {
        const decision = evaluateAutomationCondition(node, facts);
        if (decision === null) { status = "waiting_signal"; reason = "condition_unknown"; due = new Date(Date.now() + 300000); break; }
        port = decision ? "yes" : "no"; result = { decision };
      } else if (node.type === "wait") {
        due = nextAutomationBusinessTime(new Date(Date.now() + node.hours! * 3600000), graph);
        result = { waitUntil: due.toISOString() }; status = "waiting";
      } else if (node.type === "stop") { status = "completed";
      } else if (node.type === "task") {
        const saved = await upsertTaskRecord({ session, task: { title: node.title, due: new Date(Date.now() + node.dueDays! * 86400000).toISOString(), projectId: run.projectId ?? undefined, leadId: run.leadId, contactId: lead.contactId ?? undefined, ownerUserId: lead.assignedToUserId || session.userId, priority: "Normal", status: "open", metadata: { automationId: run.automationId, enrollmentId: run.id, nodeId } } });
        if (!saved.persisted) { status = "blocked"; reason = saved.reason; break; }
        result = { taskId: saved.data.id };
      } else if (node.type === "phase") {
        const saved = await upsertLeadRecord({ session, requireExisting: true, lead: { id: run.leadId, version: lead.version, status: node.value as "Neu", projectId: run.projectId ?? undefined } });
        if (!saved.persisted) { status = "blocked"; reason = saved.reason; break; }
        lead.version = saved.data.version!; facts.phase = saved.data.status; result = { status: saved.data.status, version: saved.data.version };
      } else if (node.type === "email_draft" || node.type === "request") {
        if(node.type==='request'){
          const installed=await tx.queryOne<{installed:boolean}>("select to_regclass('public.lead_customer_requests') is not null as installed");
          if(!installed?.installed){status='blocked';reason='Kundenformulare sind noch nicht eingerichtet (Migration 128).';break;}
        }
        const decision = await evaluateOutboundConsent({ session, contactId: lead.contactId, email: lead.email, projectId: run.projectId, channel: "E-Mail", purpose: "salesFollowUp" });
        let draft = await tx.queryOne<{ id: string }>(`insert into crm_automation_drafts(workspace_id,project_id,enrollment_id,node_id,contact_id,subject,body,request_type,consent_allowed,consent_reason) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10) on conflict(workspace_id,enrollment_id,node_id) do nothing returning id`, [session.workspaceId, run.projectId, run.id, nodeId, lead.contactId, node.subject, node.body, node.request ?? null, decision.allowed, decision.reason]);
        draft??=await tx.queryOne<{id:string}>(`select id from crm_automation_drafts where workspace_id=$1::uuid and enrollment_id=$2::uuid and node_id=$3`,[session.workspaceId,run.id,nodeId]);
        if(node.type==='request'&&draft){
          const {prepareAutomationCustomerRequest}=await import('@/lib/lead-customer-request-repository');
          try{await prepareAutomationCustomerRequest(tx,session,{draftId:draft.id,leadId:run.leadId,purpose:node.request!,language:node.language});}
          catch(error){if(error instanceof CrmCommandError&&['REQUEST_SETTINGS_REQUIRED','REQUEST_KEY_UNAVAILABLE'].includes(error.code)){status='blocked';reason=error.message;break;}throw error;}
        }
        result = { draftId: draft?.id ?? null, consentAllowed: decision.allowed, consentReason: decision.reason, externalSend: false }; status = "review";
      }
      await tx.execute(`insert into crm_automation_steps(workspace_id,project_id,enrollment_id,node_id,node_type,status,result) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb)`, [session.workspaceId, run.projectId, run.id, nodeId, node.type, status === "review" ? "review" : status === "waiting" ? "waiting" : "completed", JSON.stringify(result)]);
      if (status === "review" || status === "completed") break;
      nodeId = nextAutomationNode(graph, nodeId, port);
      if (status === "waiting") break;
    }
    if (!nodeId && status !== "completed") throw new CrmCommandError("INVALID_RUNTIME_EDGE", "Nächster Schritt fehlt.", 409);
    await tx.execute(`update crm_automation_enrollments set node_id=$3,status=$4,due_at=$5::timestamptz,stop_reason=$6,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, run.id, nodeId ?? run.nodeId, status, due.toISOString(), reason ?? null]);
    outcomes.push({ id: run.id, status, ...(reason ? { reason } : {}) });
  }
  return { ingested, revoked, processed: outcomes.length, outcomes, externalSends: 0 };
}

export async function reviewAutomationDraft(tx: TenantTransaction, session: AppSession, input: { id: string; dismiss: boolean }) {
  const mail=await tx.queryOne<{installed:boolean}>("select to_regclass('public.crm_automation_mail_deliveries') is not null as installed");
  if(mail?.installed){const {assertDraftNotInFlight}=await import('./mail-repository');await assertDraftNotInFlight(tx,session.workspaceId,input.id);}
  const row = await tx.queryOne<{ id: string; projectId: string | null; enrollmentId: string; nodeId: string; status: string; runStatus: string; graph: AutomationGraph }>(`select d.id,d.project_id as "projectId",d.enrollment_id as "enrollmentId",d.node_id as "nodeId",d.status,e.status as "runStatus",v.graph from crm_automation_drafts d join crm_automation_enrollments e on e.workspace_id=d.workspace_id and e.id=d.enrollment_id join crm_automation_versions v on v.workspace_id=e.workspace_id and v.automation_id=e.automation_id and v.version=e.version where d.workspace_id=$1::uuid and d.id=$2::uuid for update of d,e`, [session.workspaceId, assertCrmUuid(input.id)]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Entwurf ist nicht verfügbar.", 404);
  await scope(tx, session, row.projectId, true);
  if (row.status !== "pending" || row.runStatus !== "review") throw new CrmCommandError("REVIEW_CONFLICT", "Der Entwurf wurde bereits bearbeitet oder der Lauf gestoppt.", 409);
  const next = nextAutomationNode(validateAutomationGraph(row.graph, { allowLegacyVariables: true }), row.nodeId);
  await tx.execute(`update crm_automation_drafts set status=$3,reviewed_by=$4::uuid,reviewed_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, row.id, input.dismiss ? "dismissed" : "reviewed", session.userId]);
  await tx.execute(`update crm_automation_enrollments set status=$3,node_id=$4,due_at=now(),stop_reason=$5,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, row.enrollmentId, input.dismiss ? "stopped" : "running", next ?? row.nodeId, input.dismiss ? "draft_dismissed" : null]);
  return { id: row.id, reviewed: true, externalSend: false, continued: !input.dismiss };
}

export async function controlAutomationEnrollment(tx: TenantTransaction, session: AppSession, input: { id: string; retry: boolean }) {
  const row = await tx.queryOne<{ projectId: string | null; status: string }>(`select project_id as "projectId",status from crm_automation_enrollments where workspace_id=$1::uuid and id=$2::uuid for update`, [session.workspaceId, assertCrmUuid(input.id)]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Lauf ist nicht verfügbar.", 404);
  await scope(tx, session, row.projectId, true);
  if (input.retry && row.status !== "blocked") throw new CrmCommandError("RETRY_NOT_ALLOWED", "Nur ein blockierter Lauf kann erneut geprüft werden.", 409);
  if (!input.retry && ["completed", "stopped"].includes(row.status)) throw new CrmCommandError("RUN_FINISHED", "Dieser Lauf ist bereits beendet.", 409);
  await tx.execute(`update crm_automation_enrollments set status=$3,stop_reason=$4,due_at=now(),updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, input.id, input.retry ? "running" : "stopped", input.retry ? null : "manual_stop"]);
  return { id: input.id, status: input.retry ? "running" : "stopped" };
}

