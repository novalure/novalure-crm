import { createHash, randomBytes } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { getContactVisibilityScope } from "@/lib/contact-access";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import type { ConsentRecord, Contact, NewsletterCampaign, NewsletterSegment, NewsletterSuppression, Project } from "@/lib/crm-types";
import { evaluateOutboundConsent } from "@/lib/db/consent-policy";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { getNewsletterProviderStatus, type NewsletterProviderStatus } from "@/lib/integrations/resend";
import { dispatchApprovedNewsletter, type NewsletterDispatch, type NewsletterTransport } from "@/lib/newsletter-provider";
import {readProviderDeliveryStates} from '@/lib/db/resend-webhook-repository';
import { checkMarketingContactPolicy, previewMarketingContactPolicy, readMarketingContactPolicy } from "@/lib/db/marketing-contact-policy-repository";
import { emptyNewsletterDraft, newsletterReadyIssues, newsletterRecipientReason, normalizeNewsletterDraft, renderApprovedNewsletter, type NewsletterDraftState, type NewsletterRecipient, type SavedNewsletterDraft } from "@/lib/newsletter-workspace";
import {emptyMarketingSelection,marketingSelectionMatches,normalizeMarketingSelection,missingNewsletterVariables,type MarketingSelection,type MarketingTemplate} from '@/lib/marketing-domain';
import {marketingSchemaInstalled,assertMarketingTagScope} from '@/lib/db/marketing-repository';

export type NewsletterWorkspaceOptions = TenantTransactionOptions & { provider?: () => NewsletterProviderStatus; transport?: NewsletterTransport; origin?: string; dispatchGuard?: (tx:TenantTransaction,session:AppSession)=>Promise<void> };
type Options = NewsletterWorkspaceOptions;
type Metadata = { idempotencyKey: string; correlationId: string };
type DraftRow = { campaignId: string; projectId: string; name: string; segmentId: string | null; revision: number; approvedRevision: number | null; input: NewsletterDraftState; updatedAt: string | Date; legacySubject?: string; legacyPreview?: string; legacyBlocks?: unknown; recipientCount?: number; legacyStatus?: string };
type RecipientRow = { contactId: string; name: string; email: string | null; role: string; consentLabel: string; consentStatus: string | null; suppression: boolean;countryCode:string|null;preferredLanguage:string|null;tagIds:string[] };
const emailAddress = (value: string) => (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function maySend(session: AppSession) { return session.permissions.includes("newsletter:send") && hasProductCapability(session.productRole, "newsletter:send") && !session.serviceIdentity; }
function requireSend(session: AppSession) { if (!maySend(session)) throw new CrmCommandError("FORBIDDEN", "Mailingfreigabe erfordert Versandberechtigung.", 403); }
const campaignSelect = `select c.id as "campaignId",c.project_id as "projectId",c.name,c.segment_id as "segmentId",coalesce(d.revision,0) as revision,d.approved_revision as "approvedRevision",d.input,coalesce(d.updated_at,c.updated_at) as "updatedAt",c.subject as "legacySubject",c.preview_text as "legacyPreview",c.content_blocks as "legacyBlocks",c.recipients as "recipientCount",c.status as "legacyStatus" from newsletter_campaigns c left join crm_newsletter_drafts d on d.campaign_id=c.id and d.workspace_id=c.workspace_id`;
function restored(row: DraftRow): DraftRow { return { ...row, input: row.input ?? { ...emptyNewsletterDraft(), subject: row.legacySubject ?? "", previewText: row.legacyPreview ?? "", contentBlocks: Array.isArray(row.legacyBlocks) ? row.legacyBlocks.flatMap((block, index) => typeof block === "string" ? [{ id: `legacy-${index}`, type: "text" as const, text: block }] : []) : [] } }; }
function saved(row: DraftRow): SavedNewsletterDraft { return { campaignId: row.campaignId, projectId: row.projectId, name: row.name, segmentId: row.segmentId, revision: Number(row.revision), approvedRevision: row.approvedRevision == null ? null : Number(row.approvedRevision), input: normalizeNewsletterDraft(row.input), updatedAt: new Date(row.updatedAt).toISOString() }; }
async function senderProfile(tx: TenantTransaction, workspaceId: string) {
  const allowed = await tx.queryOne<{ allowed: boolean }>("select has_table_privilege(current_user,'public.company_profiles','SELECT') as allowed");
  if (!allowed?.allowed) return null;
  return tx.queryOne<{ name: string; address: string }>(`select coalesce(nullif(display_name,''),legal_name) as name,coalesce(nullif(business_address,''),registered_office_address) as address from company_profiles where workspace_id=$1::uuid and profile_scope='workspace_owner' and status in('approved','locked') limit 1`, [workspaceId]);
}
async function loadDraft(tx: TenantTransaction, session: AppSession, id: string, write = false) {
  const row = await tx.queryOne<DraftRow>(`${campaignSelect} where c.workspace_id=$1::uuid and c.id=$2::uuid ${write ? "for update of c" : ""}`, [session.workspaceId, assertCrmUuid(id)]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Mailingentwurf ist nicht verfügbar.", 404);
  await assertProjectGrant(tx, session, row.projectId, write); return restored(row);
}
async function recipients(tx: TenantTransaction, session: AppSession, row: DraftRow) {
  requireSend(session);
  let audience = "Alle",selection:MarketingSelection=emptyMarketingSelection();
  const marketing=await marketingSchemaInstalled(tx);
  if (row.segmentId) {
    const segment = await tx.queryOne<{ audience: string; projectId: string | null; rules: unknown;selection:unknown }>(`select audience,project_id as "projectId",rules,${marketing?'selection_rules':"null::jsonb"} as selection from newsletter_segments where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, row.segmentId]);
    if (!segment || (segment.projectId && segment.projectId !== row.projectId)) throw new CrmCommandError("SEGMENT_UNAVAILABLE", "Das Segment passt nicht zum Mailing.", 403);
    if (!Array.isArray(segment.rules) || segment.rules.length) throw new CrmCommandError("SEGMENT_REVIEW_REQUIRED", "Dieses Segment benötigt eine ausdrücklich geprüfte Empfängerauswahl.", 409);
    audience = segment.audience;
    if(marketing){try{selection=normalizeMarketingSelection(segment.selection);}catch{throw new CrmCommandError('SEGMENT_REVIEW_REQUIRED','Zielgruppenregeln sind ungültig.',409);}await assertMarketingTagScope(tx,session.workspaceId,row.projectId,selection.tagIds);}
  }
  const visibility = getContactVisibilityScope(session);
  const rows = await tx.query<RecipientRow>(`select c.id as "contactId",c.name,c.email,c.role,c.consent_label as "consentLabel",${marketing?`c.country_code as "countryCode",c.preferred_language as "preferredLanguage",array(select distinct a.tag_id::text from crm_marketing_tag_assignments a where a.workspace_id=c.workspace_id and a.project_id=c.project_id and a.active and (a.contact_id=c.id or exists(select 1 from leads l where l.workspace_id=c.workspace_id and l.project_id=c.project_id and l.id=a.lead_id and l.contact_id=c.id and l.status<>'Archiviert' and ($4::uuid is null or l.assigned_to_user_id=$4::uuid)))) as "tagIds"`:`null::text as "countryCode",null::text as "preferredLanguage",array[]::text[] as "tagIds"`},consent.status as "consentStatus",exists(select 1 from newsletter_suppressions s where s.workspace_id=c.workspace_id and lower(s.email)=lower(c.email)) as suppression from contacts c left join lateral(select status from consent_records r where r.workspace_id=c.workspace_id and r.contact_id=c.id and r.channel='Newsletter' order by r.captured_at desc,r.id desc limit 1) consent on true where c.workspace_id=$1::uuid and c.project_id=$2::uuid and c.archived_at is null and ($3='Alle' or c.role=$3) and ($4::uuid is null or c.owner_user_id=$4::uuid) order by c.id limit 10001`, [session.workspaceId, row.projectId, audience, visibility.kind === "own" ? visibility.userId : null]);
  if (visibility.kind === "none") throw new CrmCommandError("FORBIDDEN", "Kontaktzugriff fehlt.", 403);
  if (rows.length > 10000) throw new CrmCommandError("RECIPIENT_LIMIT", "Das Segment muss auf höchstens 10.000 Kontakte eingegrenzt werden.");
  const counts = new Map<string, number>();
  for (const recipient of rows) if (recipient.email) { const email = recipient.email.trim().toLowerCase(); counts.set(email, (counts.get(email) ?? 0) + 1); }
  return rows.filter(recipient=>marketingSelectionMatches(selection,recipient)).map((recipient): NewsletterRecipient => {
    const email = recipient.email?.trim().toLowerCase() ?? "";
    const reason = newsletterRecipientReason({ email, consentStatus: recipient.consentStatus, consentLabel: recipient.consentLabel, suppressed: recipient.suppression, duplicate: (counts.get(email) ?? 0) > 1 });
    return { contactId: recipient.contactId, name: recipient.name, email, eligible: reason === "allowed_opt_in", reason };
  });
}

export async function readNewsletterWorkspace(session: AppSession, projectId?: string, options: Options = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    if (fresh.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Persönliche Anmeldung erforderlich.", 403);
    if (projectId) await assertProjectGrant(tx, fresh, projectId);
    const projects = await tx.query<Project>(`select id,workspace_id as "workspaceId",name,type,status,0 as leads,'—' as revenue,'' as "defaultPipelineId" from projects where workspace_id=$1::uuid and ($2::uuid is null or id=$2::uuid) order by name`, [fresh.workspaceId, projectId ?? null]);
    const drafts = (await tx.query<DraftRow>(`${campaignSelect} where c.workspace_id=$1::uuid and c.project_id is not null and ($2::uuid is null or c.project_id=$2::uuid) order by coalesce(d.updated_at,c.updated_at) desc limit 251`, [fresh.workspaceId, projectId ?? null])).map(restored);
    if (drafts.length > 250) throw new CrmCommandError("CAMPAIGN_LIMIT", "Bitte ein Projekt für die Mailingansicht auswählen.");
    const campaigns: NewsletterCampaign[] = drafts.map(row => ({ id: row.campaignId, workspaceId: fresh.workspaceId, projectId: row.projectId, name: row.name, segmentId: row.segmentId ?? "", subject: row.input.subject, previewText: row.input.previewText, fromName: row.input.fromName, fromEmail: row.input.fromEmail, replyTo: row.input.replyTo, status: row.legacyStatus === "gesendet" ? "gesendet" : row.approvedRevision === row.revision ? "bereit" : "entwurf", goal: "", recipients: Number(row.recipientCount ?? 0), contentBlocks: [] }));
    const segments = await tx.query<NewsletterSegment>(`select id,workspace_id as "workspaceId",project_id as "projectId",name,audience,language,source,contacts_count as contacts,opt_ins as "optIns",health,rules from newsletter_segments where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by name limit 250`, [fresh.workspaceId, projectId ?? null]);
    const visibility = getContactVisibilityScope(fresh);
    const contacts = visibility.kind === "none" ? [] : await tx.query<Contact>(`select c.id,c.workspace_id as "workspaceId",c.project_id as "projectId",c.owner_user_id as "ownerUserId",c.name,c.email,c.phone,c.role,c.source,c.intent,c.consent_label as consent,p.name as project from contacts c join projects p on p.id=c.project_id and p.workspace_id=c.workspace_id where c.workspace_id=$1::uuid and ($2::uuid is null or c.project_id=$2::uuid) and c.archived_at is null and ($3::uuid is null or c.owner_user_id=$3::uuid) order by c.id limit 10001`, [fresh.workspaceId, projectId ?? null, visibility.kind === "own" ? visibility.userId : null]);
    if (contacts.length > 10000) throw new CrmCommandError("CONTACT_LIMIT", "Bitte die Mailingansicht auf ein Projekt eingrenzen.");
    const ids = contacts.map(contact => contact.id);
    const consents = await tx.query<ConsentRecord>(`select distinct on(contact_id,channel) id,workspace_id as "workspaceId",contact_id as "contactId",project_id as "projectId",channel,status,source,captured_at::text as "capturedAt" from consent_records where workspace_id=$1::uuid and contact_id=any($2::uuid[]) and channel='Newsletter' order by contact_id,channel,captured_at desc,id desc`, [fresh.workspaceId, ids]);
    const suppressions = await tx.query<NewsletterSuppression>(`select id,workspace_id as "workspaceId",email,reason,source,captured_at::text as "capturedAt" from newsletter_suppressions where workspace_id=$1::uuid and lower(email)=any($2::text[])`, [fresh.workspaceId, contacts.map(contact => (contact.email ?? "").toLowerCase())]);
    const consentByContact = new Map(consents.map(consent => [consent.contactId, consent.status])), suppressedEmails = new Set(suppressions.map(item => item.email.toLowerCase()));
    for (const segment of segments) {
      const selected = contacts.filter(contact => (!segment.projectId || contact.projectId === segment.projectId) && (segment.audience === "Alle" || contact.role === segment.audience));
      segment.contacts = selected.length;
      segment.optIns = selected.filter(contact => newsletterRecipientReason({ email: contact.email ?? "", consentLabel: contact.consent, consentStatus: consentByContact.get(contact.id), suppressed: suppressedEmails.has((contact.email ?? "").toLowerCase()) }) === "allowed_opt_in").length;
    }
    const deliveries = await tx.query<{ id: string; campaignId: string; revision: number; email: string; status: string; error: string | null; createdAt: string; acceptedAt: string | null }>(`select d.id,d.campaign_id as "campaignId",d.revision,d.to_email as email,d.status,d.error,d.created_at::text as "createdAt",d.accepted_at::text as "acceptedAt" from crm_newsletter_deliveries d where d.workspace_id=$1::uuid and ($2::uuid is null or d.project_id=$2::uuid) and $4::boolean and exists(select 1 from contacts c where c.workspace_id=d.workspace_id and c.id=d.contact_id and ($3::uuid is null or c.owner_user_id=$3::uuid)) order by d.created_at desc limit 250`, [fresh.workspaceId, projectId ?? null,visibility.kind==='own'?visibility.userId:null,visibility.kind!=='none']);
    const testSends = await tx.query<{ id: string; campaignId: string; revision: number; email: string; status: string; error: string | null; createdAt: string }>(`select id,campaign_id as "campaignId",revision,to_email as email,status,error,created_at::text as "createdAt" from crm_newsletter_test_sends where workspace_id=$1::uuid and actor_id=$3::uuid and ($2::uuid is null or project_id=$2::uuid) order by created_at desc limit 50`, [fresh.workspaceId, projectId ?? null, fresh.userId]);
    const providerStates=await readProviderDeliveryStates(tx,fresh.workspaceId,[...deliveries.map(row=>({id:row.id,kind:'newsletter' as const})),...testSends.map(row=>({id:row.id,kind:'newsletter_test' as const}))]);
    const provider = (options.provider ?? getNewsletterProviderStatus)();
    const profile = await senderProfile(tx, fresh.workspaceId);
    const marketing=await marketingSchemaInstalled(tx);
    const templates=marketing?await tx.query<MarketingTemplate>('select id,project_id as "projectId",name,revision,variants from crm_marketing_templates where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by name limit 1000',[fresh.workspaceId,projectId??null]):[];
    const templateBindings=marketing?await tx.query<{campaignId:string;templateId:string;revision:number;language:string}>('select campaign_id as "campaignId",source_template_id as "templateId",source_template_revision as revision,source_template_language as language from crm_newsletter_drafts where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and source_template_id is not null',[fresh.workspaceId,projectId??null]):[];
    if(marketing&&maySend(fresh))for(const segment of segments){if(!segment.projectId)continue;const list=await recipients(tx,fresh,{campaignId:'',projectId:segment.projectId,name:segment.name,segmentId:segment.id,revision:0,approvedRevision:null,input:emptyNewsletterDraft(),updatedAt:new Date()});segment.contacts=list.length;segment.optIns=list.filter(row=>row.eligible).length;}
    return { source: "database" as const, workspaceId: fresh.workspaceId, drafts: drafts.map(saved), campaigns, segments, projects, contacts, consents, suppressions, templates,templateBindings,deliveries:deliveries.map(row=>({...row,providerStatus:providerStates.get('newsletter:'+row.id)??null})), testSends:testSends.map(row=>({...row,providerStatus:providerStates.get('newsletter_test:'+row.id)??null})), canEdit: fresh.permissions.includes("crm:write") && hasProductCapability(fresh.productRole, "workspace:operate"), canApprove: maySend(fresh), provider: { configured: provider.configured, fromEmail: provider.configured ? emailAddress(provider.from) : "" }, sender: { name: profile?.name || fresh.workspaceName, address: profile?.address || "" } };
  }, options);
}

export async function createNewsletterDraft(session: AppSession, input: { projectId: string; name: string; audience: string; language: "de" | "en" | "es" }, metadata: Metadata, options: Options = {}) {
  if (!input.name.trim() || input.name.length > 180 || !["Alle", "Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"].includes(input.audience) || !["de", "en", "es"].includes(input.language)) throw new CrmCommandError("INVALID_CAMPAIGN", "Name, Sprache und Zielgruppe sind erforderlich.");
  return executeCrmCommand(session, { operation: "crm.newsletter.create", projectId: assertCrmUuid(input.projectId), capability: "workspace:operate", payload: input, ...metadata }, async (tx, context) => {
    const segment = await tx.queryOne<{ id: string }>(`insert into newsletter_segments(workspace_id,project_id,name,audience,language,source,rules) values($1::uuid,$2::uuid,$3,$4,$5,'CRM','[]') returning id`, [context.workspaceId, input.projectId, input.name.trim(), input.audience, input.language]);
    const campaign = await tx.queryOne<{ id: string }>(`insert into newsletter_campaigns(workspace_id,project_id,segment_id,name,subject,status) values($1::uuid,$2::uuid,$3::uuid,$4,'','entwurf') returning id`, [context.workspaceId, input.projectId, segment!.id, input.name.trim()]);
    const provider = (options.provider ?? getNewsletterProviderStatus)();
    const profile = await senderProfile(tx, context.workspaceId);
    const draft = { ...emptyNewsletterDraft(provider.configured ? emailAddress(provider.from) : "", profile?.name || context.session.workspaceName), legalAddress: profile?.address || "", language: input.language };
    await tx.execute(`insert into crm_newsletter_drafts(workspace_id,project_id,campaign_id,input,updated_by) values($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid)`, [context.workspaceId, input.projectId, campaign!.id, JSON.stringify(draft), context.actorId]);
    return { persisted: true, campaignId: campaign!.id, revision: 1 };
  }, options);
}

/** Both the standalone audience screen and each final dispatch use recipients(). */
export async function previewNewsletterAudience(session:AppSession,projectId:string,segmentId:string,options:Options={}){
 return withCrmRead(session,async(tx,fresh)=>{await assertProjectGrant(tx,fresh,assertCrmUuid(projectId));assertCrmUuid(segmentId);const list=await recipients(tx,fresh,{campaignId:'',projectId,name:'',segmentId,revision:0,approvedRevision:null,input:emptyNewsletterDraft(),updatedAt:new Date()});const policies=await previewMarketingContactPolicy(tx,fresh,list.filter(row=>row.eligible));for(const row of list)if(row.eligible)row.deliveryPolicy=policies.get(row.contactId);return{segmentId,projectId,recipients:list,eligible:list.filter(row=>row.eligible).length,excluded:list.filter(row=>!row.eligible).length};},options);
}
export async function configureNewsletterMarketing(session:AppSession,input:{campaignId:string;expectedRevision:number;segmentId?:string;templateId?:string;templateRevision?:number;language?:'de'|'en'|'es'},metadata:Metadata,options:Options={}){
 return withCrmRead(session,async(tx,fresh)=>{
  const current=await loadDraft(tx,fresh,input.campaignId,true);
  return executeCrmCommand(fresh,{operation:'crm.newsletter.configure',resourceId:input.campaignId,projectId:current.projectId,capability:'workspace:operate',payload:input,...metadata},async(commandTx,context)=>{
   if(!await marketingSchemaInstalled(commandTx))throw new CrmCommandError('MARKETING_MIGRATION_REQUIRED','Gespeicherte Marketingdaten sind noch nicht eingerichtet.',409);
   if(Number(current.revision)!==input.expectedRevision||!input.expectedRevision)throw new CrmCommandError('VERSION_CONFLICT','Mailing wurde geändert. Bitte neu laden.',409);
   if(await commandTx.queryOne("select id from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and status in('claimed','uncertain') limit 1",[context.workspaceId,input.campaignId]))throw new CrmCommandError('SEND_IN_PROGRESS','Ein Versandvorgang ist noch ungeklärt.',409);
   let draft=normalizeNewsletterDraft(current.input);
   if(input.segmentId){
    const segment=await commandTx.queryOne<{selection:unknown;rules:unknown}>('select selection_rules as selection,rules from newsletter_segments where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid for share',[context.workspaceId,current.projectId,assertCrmUuid(input.segmentId)]);
    if(!segment||!Array.isArray(segment.rules)||segment.rules.length)throw new CrmCommandError('SEGMENT_UNAVAILABLE','Zielgruppe ist nicht verfügbar bzw. nicht geprüft.',409);
    let selection;try{selection=normalizeMarketingSelection(segment.selection);}catch{throw new CrmCommandError('SEGMENT_UNAVAILABLE','Zielgruppenregeln sind ungültig.',409);}await assertMarketingTagScope(commandTx,context.workspaceId,current.projectId,selection.tagIds);
   }
   if(input.templateId){
    const template=await commandTx.queryOne<MarketingTemplate>('select template_id as id,project_id as "projectId",name,revision,variants from crm_marketing_template_versions where workspace_id=$1::uuid and project_id=$2::uuid and template_id=$3::uuid and revision=$4',[context.workspaceId,current.projectId,assertCrmUuid(input.templateId),input.templateRevision]);
    const variant=template&&input.language?template.variants[input.language]:undefined;
    if(!variant)throw new CrmCommandError('TEMPLATE_UNAVAILABLE','Diese gespeicherte Vorlagenrevision/Sprache ist nicht verfügbar.',409);
    draft=normalizeNewsletterDraft({...draft,...variant,language:input.language});
   }
   if(!input.templateId&&!input.segmentId)throw new CrmCommandError('INVALID_MARKETING','Vorlage oder Zielgruppe auswählen.');
   const row=await commandTx.queryOne<{revision:number}>(`update crm_newsletter_drafts set input=$3::jsonb,revision=revision+1,approved_revision=null,updated_by=$4::uuid,updated_at=now(),source_template_id=case when $6::uuid is null then source_template_id else $6::uuid end,source_template_revision=case when $6::uuid is null then source_template_revision else $7 end,source_template_language=case when $6::uuid is null then source_template_language else $8 end where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$5 returning revision`,[context.workspaceId,input.campaignId,JSON.stringify(draft),context.actorId,input.expectedRevision,input.templateId??null,input.templateRevision??null,input.language??null]);
   if(!row)throw new CrmCommandError('VERSION_CONFLICT','Mailing wurde geändert.',409);
   await commandTx.execute(`update newsletter_campaigns set segment_id=coalesce($3::uuid,segment_id),subject=$4,preview_text=$5,content_blocks=$6::jsonb,status='entwurf',updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`,[context.workspaceId,input.campaignId,input.segmentId??null,draft.subject,draft.previewText,JSON.stringify(draft.contentBlocks)]);
   await commandTx.execute("update crm_newsletter_deliveries set status='cancelled',updated_at=now() where workspace_id=$1::uuid and campaign_id=$2::uuid and status='pending'",[context.workspaceId,input.campaignId]);
   return{persisted:true,campaignId:input.campaignId,revision:row.revision};
  },options);
 },options);
}

export async function saveNewsletterDraft(session: AppSession, input: { campaignId: string; expectedRevision: number; draft: unknown }, metadata: Metadata, options: Options = {}) {
  const draft = normalizeNewsletterDraft(input.draft);
  return withCrmRead(session, async (tx, fresh) => {
    const current = await loadDraft(tx, fresh, input.campaignId, true);
    return executeCrmCommand(fresh, { operation: "crm.newsletter.save", resourceId: input.campaignId, projectId: current.projectId, capability: "workspace:operate", payload: { ...input, draft }, ...metadata }, async (commandTx, context) => {
      if (Number(current.revision) !== input.expectedRevision) throw new CrmCommandError("VERSION_CONFLICT", "Der Mailingentwurf wurde geändert. Bitte neu laden.", 409);
      if (await commandTx.queryOne("select id from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and status in('claimed','uncertain') limit 1", [context.workspaceId, input.campaignId])) throw new CrmCommandError("SEND_IN_PROGRESS", "Ein Versandvorgang wird noch geklärt. Bitte zuerst dessen Ergebnis prüfen.", 409);
      const result = current.revision === 0
        ? await commandTx.queryOne<{ revision: number }>(`insert into crm_newsletter_drafts(workspace_id,project_id,campaign_id,input,updated_by) values($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) returning revision`, [context.workspaceId, current.projectId, input.campaignId, JSON.stringify(draft), context.actorId])
        : await commandTx.queryOne<{ revision: number }>(`update crm_newsletter_drafts set input=$3::jsonb,revision=revision+1,approved_revision=null,updated_by=$4::uuid,updated_at=now() where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$5 returning revision`, [context.workspaceId, input.campaignId, JSON.stringify(draft), context.actorId, input.expectedRevision]);
      if (!result) throw new CrmCommandError("VERSION_CONFLICT", "Der Entwurf wurde geändert.", 409);
      await commandTx.execute(`update crm_newsletter_deliveries set status='cancelled',updated_at=now() where workspace_id=$1::uuid and campaign_id=$2::uuid and status='pending'`, [context.workspaceId, input.campaignId]);
      await commandTx.execute(`update newsletter_campaigns set subject=$3,preview_text=$4,status='entwurf',content_blocks=$5::jsonb,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [context.workspaceId, input.campaignId, draft.subject, draft.previewText, JSON.stringify(draft.contentBlocks)]);
      return { persisted: true, campaignId: input.campaignId, revision: Number(result.revision) };
    }, options);
  }, options);
}

export async function previewNewsletterRecipients(session: AppSession, campaignId: string, options: Options = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    const row = await loadDraft(tx, fresh, campaignId), list = await recipients(tx, fresh, row);
    const draft = normalizeNewsletterDraft(row.input), provider = (options.provider ?? getNewsletterProviderStatus)();
    const issues = newsletterReadyIssues(draft);
    const project=await tx.queryOne<{name:string}>('select name from projects where workspace_id=$1::uuid and id=$2::uuid',[fresh.workspaceId,row.projectId]);
    const missing=list.filter(recipient=>recipient.eligible&&missingNewsletterVariables(draft,{contactName:recipient.name,projectName:project?.name,agentName:fresh.name}).length);
    if(missing.length)issues.push(`Pflichtvariablen fehlen bei ${missing.length} Empfänger(n). Bitte Kontaktname, Projektname und Absender prüfen.`);
    if (!provider.configured) issues.push("Der Versanddienst ist nicht eingerichtet.");
    else if (emailAddress(provider.from) !== draft.fromEmail.toLowerCase()) issues.push("Die Absenderadresse stimmt nicht mit dem eingerichteten Versandabsender überein.");
    const statuses = await tx.query<{ status: string; count: number }>("select status,count(*)::integer as count from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$3 group by status", [fresh.workspaceId, campaignId, row.revision]);
    const policies=await previewMarketingContactPolicy(tx,fresh,list.filter(recipient=>recipient.eligible));for(const recipient of list)if(recipient.eligible)recipient.deliveryPolicy=policies.get(recipient.contactId);
    return { campaignId, revision: Number(row.revision), approved: row.approvedRevision === row.revision, recipients: list, eligible: list.filter(recipient => recipient.eligible).length, sendableNow:list.filter(recipient=>recipient.eligible&&recipient.deliveryPolicy?.allowed).length,deferred:list.filter(recipient=>recipient.eligible&&recipient.deliveryPolicy?.allowed===false).length, excluded: list.filter(recipient => !recipient.eligible).length, issues, statuses };
  }, options);
}

export async function approveNewsletter(session: AppSession, input: { campaignId: string; expectedRevision: number }, metadata: Metadata, options: Options = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    requireSend(fresh); const row = await loadDraft(tx, fresh, input.campaignId, true);
    return executeCrmCommand(fresh, { operation: "crm.newsletter.approve", resourceId: input.campaignId, projectId: row.projectId, capability: "newsletter:send", payload: input, ...metadata }, async (commandTx, context) => {
      if (Number(row.revision) !== input.expectedRevision) throw new CrmCommandError("VERSION_CONFLICT", "Der Entwurf wurde geändert.", 409);
      if (Number(row.revision) === 0) throw new CrmCommandError("DRAFT_SAVE_REQUIRED", "Bitte den Entwurf zuerst speichern.", 409);
      if (row.approvedRevision === row.revision) return { persisted: true, campaignId: input.campaignId, revision: Number(row.revision), alreadyApproved: true };
      const draft = normalizeNewsletterDraft(row.input), issues = newsletterReadyIssues(draft), provider = (options.provider ?? getNewsletterProviderStatus)();
      if (!provider.configured || emailAddress(provider.from) !== draft.fromEmail.toLowerCase()) issues.push("Ein passender Versandabsender ist erforderlich.");
      if (issues.length) throw new CrmCommandError("MAILING_NOT_READY", issues.join(" "), 409);
      const list = (await recipients(commandTx, context.session, row)).filter(recipient => recipient.eligible);
      if (!list.length) throw new CrmCommandError("NO_RECIPIENTS", "Keine aktuell berechtigten Empfänger.", 409);
      const project = await commandTx.queryOne<{ name: string }>("select name from projects where workspace_id=$1::uuid and id=$2::uuid", [context.workspaceId, row.projectId]);
      if(list.some(recipient=>missingNewsletterVariables(draft,{contactName:recipient.name,projectName:project?.name,agentName:context.session.name}).length))throw new CrmCommandError('TEMPLATE_VARIABLE_MISSING','Eine Pflichtvariable fehlt. Bitte die Empfängervorschau prüfen.',409);
      await commandTx.execute(`insert into crm_newsletter_versions(workspace_id,project_id,campaign_id,revision,input,content_digest,approved_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7::uuid)`, [context.workspaceId, row.projectId, input.campaignId, row.revision, JSON.stringify(draft), crmPayloadDigest(draft), context.actorId]);
      for (const recipient of list) {
        const token = randomBytes(32).toString("base64url"), url = new URL("/api/public/newsletter/unsubscribe", options.origin ?? getTrustedAppOrigin()); url.searchParams.set("token", token);
        const personalize = (value: string) => value.replaceAll("{{contact.name}}", recipient.name).replaceAll("{{project.name}}", project?.name ?? "").replaceAll("{{agent.name}}", context.session.name).replace(/[\r\n]/g, " ");
        const payload: Omit<NewsletterDispatch, "idempotencyKey"> = { to: recipient.email, from: `${JSON.stringify(draft.fromName)} <${draft.fromEmail}>`, replyTo: draft.replyTo || undefined, subject: personalize(draft.subject), html: renderApprovedNewsletter(draft, { contactName: recipient.name, projectName: project?.name ?? "", agentName: context.session.name, unsubscribeUrl: url.toString() }), unsubscribeUrl: url.toString() };
        await commandTx.execute(`insert into crm_newsletter_deliveries(workspace_id,project_id,campaign_id,revision,contact_id,to_email,payload,unsubscribe_token_hash) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::jsonb,$8)`, [context.workspaceId, row.projectId, input.campaignId, row.revision, recipient.contactId, recipient.email, JSON.stringify(payload), hash(token)]);
      }
      await commandTx.execute(`update crm_newsletter_drafts set approved_revision=revision where workspace_id=$1::uuid and campaign_id=$2::uuid`, [context.workspaceId, input.campaignId]);
      await commandTx.execute(`update newsletter_campaigns set status='bereit',recipients=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [context.workspaceId, input.campaignId, list.length]);
      return { persisted: true, campaignId: input.campaignId, revision: Number(row.revision), recipients: list.length };
    }, options);
  }, options);
}

export async function sendNewsletterBatch(session: AppSession, input: { campaignId: string; expectedRevision: number }, metadata: Metadata, options: Options = {}) {
  const provider = (options.provider ?? getNewsletterProviderStatus)();
  if (!provider.configured) throw new CrmCommandError("PROVIDER_UNAVAILABLE", "Der Versanddienst ist nicht eingerichtet.", 503);
  const receipt = await withCrmRead(session, async (tx, fresh) => {
    requireSend(fresh); const row = await loadDraft(tx, fresh, input.campaignId, true);
    return executeCrmCommand(fresh, { operation: "crm.newsletter.dispatch", resourceId: input.campaignId, projectId: row.projectId, capability: "newsletter:send", payload: input, ...metadata }, async (commandTx, context) => {
      if (Number(row.revision) !== input.expectedRevision || row.approvedRevision !== row.revision) throw new CrmCommandError("APPROVAL_REQUIRED", "Die aktuelle Mailingversion benötigt eine Freigabe.", 409);
      if (options.dispatchGuard) await options.dispatchGuard(commandTx,context.session);
      else if ((await commandTx.queryOne<{installed:boolean}>("select to_regclass('public.crm_newsletter_schedules') is not null as installed"))?.installed && await commandTx.queryOne("select id from crm_newsletter_schedules where workspace_id=$1::uuid and campaign_id=$2::uuid and status in('queued','running') limit 1",[context.workspaceId,input.campaignId])) throw new CrmCommandError("SCHEDULE_ACTIVE","Für dieses Mailing besteht ein Zeitplan. Bitte diesen zuerst ausdrücklich absagen.",409);
      if(await commandTx.queryOne("select id from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and status in('claimed','uncertain') limit 1",[context.workspaceId,input.campaignId]))throw new CrmCommandError("SEND_IN_PROGRESS","Ein früherer Versandauftrag ist noch ungeklärt. Es wird kein weiterer Auftrag gestartet.",409);
      if (emailAddress(provider.from) !== normalizeNewsletterDraft(row.input).fromEmail.toLowerCase()) throw new CrmCommandError("SENDER_CHANGED", "Der Versandabsender hat sich geändert. Bitte den Entwurf prüfen.", 409);
      const policyState=await readMarketingContactPolicy(context.session,options),respectDeferred=policyState.policy?.rules.enabled===true;
      const selected = await commandTx.query<{ id: string; contactId:string; email:string }>(`select id,contact_id as "contactId",to_email as email from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$3 and status='pending' and (not $4::boolean or updated_at<$5::timestamptz or error is null or error not like 'contact_policy_deferred:%' or error<='contact_policy_deferred:'||to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by contact_id,id for update skip locked limit 50`, [context.workspaceId, input.campaignId, row.revision,respectDeferred,policyState.policy?.updatedAt??null]);
      const ids:string[]=[],deferred:Array<{id:string;nextAllowedAt:string|null}>=[];
      for (const delivery of selected) {
        const policy=await checkMarketingContactPolicy(commandTx,context.session,{contactId:delivery.contactId,email:delivery.email,lock:true});
        if(!policy.allowed){deferred.push({id:delivery.id,nextAllowedAt:policy.nextAllowedAt});await commandTx.execute("update crm_newsletter_deliveries set error=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid",[context.workspaceId,delivery.id,policy.nextAllowedAt?`contact_policy_deferred:${policy.nextAllowedAt}`:'contact_policy_review']);continue;}
        await commandTx.execute(`update crm_newsletter_deliveries set status='claimed',claimed_by=$3::uuid,claimed_at=now(),error=null,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status='pending'`, [context.workspaceId, delivery.id, context.commandId]);ids.push(delivery.id);
      }
      return { persisted: true, ids,deferred, campaignId: input.campaignId, revision: Number(row.revision) };
    }, options);
  }, options);
  // A replay observes its durable claim; it does not dispatch an already claimed message again.
  let gate = Promise.resolve();
  const deferredAfterClaim:Array<{id:string;nextAllowedAt:string|null}>=[];
  const rateGate = async () => { if (options.transport) return; const next = gate.then(() => new Promise<void>(resolve => setTimeout(resolve, 150))); gate = next; await next; };
  async function dispatchOne(id: string) {
    await rateGate();
    await withCrmRead(session, async (tx, fresh) => {
      requireSend(fresh);
      if(options.dispatchGuard)await options.dispatchGuard(tx,fresh);
      const row = await tx.queryOne<{ id: string; projectId: string; contactId: string; email: string; payload: Omit<NewsletterDispatch, "idempotencyKey">; approvedRevision: number | null; revision: number; currentRevision: number }>(`select d.id,d.project_id as "projectId",d.contact_id as "contactId",d.to_email as email,d.payload,d.revision,s.revision as "currentRevision",s.approved_revision as "approvedRevision" from crm_newsletter_deliveries d join crm_newsletter_drafts s on s.workspace_id=d.workspace_id and s.campaign_id=d.campaign_id where d.workspace_id=$1::uuid and d.id=$2::uuid and d.status='claimed' and d.claimed_by=$3::uuid for update of d for share of s`, [fresh.workspaceId, id, receipt.commandId]);
      if (!row) return null;
      await assertProjectGrant(tx, fresh, row.projectId, true);
      const contactPolicy=await checkMarketingContactPolicy(tx,fresh,{contactId:row.contactId,email:row.email,excludeDelivery:{kind:'newsletter',id:row.id},lock:true});
      if(!contactPolicy.allowed){await tx.execute("update crm_newsletter_deliveries set status='pending',claimed_by=null,claimed_at=null,error=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid",[fresh.workspaceId,row.id,contactPolicy.nextAllowedAt?`contact_policy_deferred:${contactPolicy.nextAllowedAt}`:'contact_policy_review']);deferredAfterClaim.push({id:row.id,nextAllowedAt:contactPolicy.nextAllowedAt});return null;}
      const current = await tx.queryOne<{ email: string; projectId: string }>("select email,project_id as \"projectId\" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null for share", [fresh.workspaceId, row.contactId]);
      let reason = row.revision !== row.currentRevision || row.approvedRevision !== row.revision ? "approval_changed" : !current || current.projectId !== row.projectId || current.email?.trim().toLowerCase() !== row.email ? "recipient_changed" : "";
      if(!reason){const campaign=await loadDraft(tx,fresh,input.campaignId);const selected=await recipients(tx,fresh,campaign);if(!selected.some(candidate=>candidate.contactId===row.contactId&&candidate.eligible))reason='audience_or_consent_changed';}
      if (!reason) { const decision = await evaluateOutboundConsent({ session: fresh, projectId: row.projectId, contactId: row.contactId, email: row.email, channel: "Newsletter", purpose: "newsletter", metadata: { campaignId: input.campaignId, deliveryId: id, revision: row.revision } }); if (!decision.allowed) reason = decision.reason; }
      if (reason) { await tx.execute("update crm_newsletter_deliveries set status='suppressed',error=$3,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid", [fresh.workspaceId, id, reason]); return null; }
      const prepared={ ...row.payload, idempotencyKey: `newsletter/${id}`,reference:{kind:'newsletter' as const,id} };
      const received = await (options.transport ?? dispatchApprovedNewsletter)(prepared).catch(() => ({ status: "uncertain" as const, error: "Versandergebnis ungeklärt." }));
      const result = received.status === "accepted" && !received.messageId ? { status: "uncertain" as const, error: "Der Versanddienst hat keine Annahme-ID bestätigt." } : received;
      await tx.execute(`update crm_newsletter_deliveries set status=$4,provider_message_id=$5,error=$6,accepted_at=case when $4='accepted' then now() else null end,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and claimed_by=$3::uuid and status='claimed'`, [fresh.workspaceId, id, receipt.commandId, result.status, result.status === "accepted" ? result.messageId ?? null : null, result.error ?? null]);
    }, options);
  }
  if (!receipt.replayed) {
    let index = 0;
    const outcomes=await Promise.allSettled(Array.from({ length: Math.min(3, receipt.data.ids.length) }, async () => { while (index < receipt.data.ids.length) { const id = receipt.data.ids[index++]; await dispatchOne(id); } }));
    const failed=outcomes.find(outcome=>outcome.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }
  return withCrmRead(session, async (tx, fresh) => {
    const policyState=await readMarketingContactPolicy(fresh,options),pending=await tx.query<{error:string|null;updatedAt:string}>("select error,updated_at::text as \"updatedAt\" from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$3 and status='pending'",[fresh.workspaceId,input.campaignId,input.expectedRevision]);
    const dates=pending.flatMap(row=>{if(!policyState.policy?.rules.enabled||Date.parse(row.updatedAt)<Date.parse(policyState.policy.updatedAt??''))return[];const value=row.error?.startsWith('contact_policy_deferred:')?row.error.slice('contact_policy_deferred:'.length):'';return Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now()?[value]:[];});
    const deferred=[...(receipt.data.deferred??[]),...deferredAfterClaim],policyReviewRequired=policyState.policy?.rules.enabled===true&&pending.some(row=>row.error==='contact_policy_review');
    return { persisted: true, replayed: receipt.replayed, campaignId: input.campaignId, revision: input.expectedRevision, dispatched: receipt.replayed ? 0 : receipt.data.ids.length-deferredAfterClaim.length,deferred:dates.length,readyPending:pending.length-dates.length,nextAllowedAt:pending.length===dates.length?dates.sort()[0]??null:null,policyReviewRequired,policyDeferredThisBatch:deferred.length,statuses: await tx.query<{ status: string; count: number }>("select status,count(*)::integer as count from crm_newsletter_deliveries where workspace_id=$1::uuid and campaign_id=$2::uuid and revision=$3 group by status", [fresh.workspaceId, input.campaignId, input.expectedRevision]) };
  }, options);
}

/** A deliberate test goes only to the current authenticated member, never to a CRM recipient list. */
export async function sendNewsletterTest(session: AppSession, input: { campaignId: string; expectedRevision: number }, metadata: Metadata, options: Options = {}) {
  const provider = (options.provider ?? getNewsletterProviderStatus)();
  if (!provider.configured) throw new CrmCommandError("PROVIDER_UNAVAILABLE", "Der Versanddienst ist nicht eingerichtet.", 503);
  const receipt = await withCrmRead(session, async (tx, fresh) => {
    requireSend(fresh); const row = await loadDraft(tx, fresh, input.campaignId, true);
    return executeCrmCommand(fresh, { operation: "crm.newsletter.test", resourceId: input.campaignId, projectId: row.projectId, capability: "newsletter:send", payload: input, ...metadata }, async (commandTx, context) => {
      if (Number(row.revision) !== input.expectedRevision || Number(row.revision) === 0) throw new CrmCommandError("VERSION_CONFLICT", "Bitte die gespeicherte Entwurfsfassung neu laden.", 409);
      const draft = normalizeNewsletterDraft(row.input), issues = newsletterReadyIssues(draft);
      if (emailAddress(provider.from) !== draft.fromEmail.toLowerCase()) issues.push("Passender Versandabsender fehlt.");
      if (issues.length) throw new CrmCommandError("MAILING_NOT_READY", issues.join(" "), 409);
      if (await commandTx.queryOne("select id from crm_newsletter_test_sends where workspace_id=$1::uuid and campaign_id=$2::uuid and actor_id=$3::uuid and status in('claimed','uncertain') limit 1", [context.workspaceId, input.campaignId, context.actorId])) throw new CrmCommandError("TEST_UNCERTAIN", "Ein vorheriger Testversand muss zuerst abgeglichen werden.", 409);
      const member = await commandTx.queryOne<{ name: string; email: string }>("select name,email from workspace_users where workspace_id=$1::uuid and id=$2::uuid and status='active'", [context.workspaceId, context.actorId]);
      if (!member || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) throw new CrmCommandError("TEST_ADDRESS_MISSING", "Das angemeldete Konto benötigt eine gültige E-Mail-Adresse.", 409);
      const project = await commandTx.queryOne<{ name: string }>("select name from projects where workspace_id=$1::uuid and id=$2::uuid", [context.workspaceId, row.projectId]);
      const subject = draft.subject.replaceAll("{{contact.name}}", member.name).replaceAll("{{project.name}}", project?.name ?? "").replaceAll("{{agent.name}}", member.name).replace(/[\r\n]/g, " ");
      const payload: Omit<NewsletterDispatch, "idempotencyKey"> = { to: member.email.trim().toLowerCase(), from: `${JSON.stringify(draft.fromName)} <${draft.fromEmail}>`, replyTo: draft.replyTo || undefined, subject: `[TEST] ${subject}`, html: renderApprovedNewsletter(draft, { contactName: member.name, projectName: project?.name ?? "", agentName: member.name, unsubscribeUrl: "", test: true }) };
      await commandTx.execute(`insert into crm_newsletter_test_sends(id,workspace_id,project_id,campaign_id,revision,actor_id,to_email,input_digest,payload,status) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9::jsonb,'claimed')`, [context.commandId, context.workspaceId, row.projectId, input.campaignId, row.revision, context.actorId, payload.to, crmPayloadDigest(draft), JSON.stringify(payload)]);
      return { persisted: true, id: context.commandId, email: payload.to };
    }, options);
  }, options);
  if (!receipt.replayed) {
    const prepared = await withCrmRead(session, async (tx, fresh) => {
      requireSend(fresh);
      const row = await tx.queryOne<{ payload: Omit<NewsletterDispatch, "idempotencyKey">; revision: number; currentRevision: number; digest: string; currentInput: NewsletterDraftState; email: string; currentEmail: string }>(`select t.payload,t.revision,d.revision as "currentRevision",t.input_digest as digest,d.input as "currentInput",t.to_email as email,u.email as "currentEmail" from crm_newsletter_test_sends t join crm_newsletter_drafts d on d.campaign_id=t.campaign_id and d.workspace_id=t.workspace_id join workspace_users u on u.id=t.actor_id and u.workspace_id=t.workspace_id and u.status='active' where t.workspace_id=$1::uuid and t.id=$2::uuid and t.actor_id=$3::uuid and t.status='claimed'`, [fresh.workspaceId, receipt.data.id, fresh.userId]);
      if (!row) return null;
      if (row.revision !== row.currentRevision || row.digest !== crmPayloadDigest(row.currentInput) || row.email !== row.currentEmail.trim().toLowerCase()) { await tx.execute("update crm_newsletter_test_sends set status='cancelled',error='draft_or_member_changed',updated_at=now() where workspace_id=$1::uuid and id=$2::uuid", [fresh.workspaceId, receipt.data.id]); return null; }
      return { ...row.payload, idempotencyKey: `newsletter-test/${receipt.data.id}`,reference:{kind:'newsletter_test' as const,id:receipt.data.id} };
    }, options);
    if (prepared) {
      const received = await (options.transport ?? dispatchApprovedNewsletter)(prepared).catch(() => ({ status: "uncertain" as const, error: "Testversandergebnis ungeklärt." }));
      const result = received.status === "accepted" && !received.messageId ? { status: "uncertain" as const, error: "Die Annahme-ID fehlt." } : received;
      await withCrmRead(session, async (tx, fresh) => { requireSend(fresh); await tx.execute("update crm_newsletter_test_sends set status=$3,provider_message_id=$4,error=$5,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status='claimed'", [fresh.workspaceId, receipt.data.id, result.status, result.status === "accepted" ? result.messageId ?? null : null, result.error ?? null]); }, options);
    }
  }
  return withCrmRead(session, async (tx, fresh) => ({ persisted: true, replayed: receipt.replayed, test: true, campaignId: input.campaignId, ...(await tx.queryOne<{ status: string; email: string; error: string | null }>("select status,to_email as email,error from crm_newsletter_test_sends where workspace_id=$1::uuid and id=$2::uuid", [fresh.workspaceId, receipt.data.id])) }), options);
}
