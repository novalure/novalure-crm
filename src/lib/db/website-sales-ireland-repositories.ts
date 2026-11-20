import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import {
  assertCrmFields, assertCrmUuid, assertExpectedVersion, assertProjectGrant,
  CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead,
  type CrmCommandContext, type TenantTransaction, type TenantTransactionOptions,
} from "@/lib/crm-command";
import { executeOfferCommand } from "@/lib/db/offer-repositories";
import { parseOfferContent, OfferValidationError } from "@/lib/offer-workflow";
import { decideWebsiteInvestment, qualifyWebsiteProspect, type WebsiteProspectQualification } from "@/lib/website-prospect";
import { websiteSalesActorAuthority } from "@/lib/website-sales-machine-authority";

export const websiteSalesIrelandContract = "website-sales-ireland-v1";
export const websiteSalesIrelandPath = "/api/crm/website-sales";
type Operation = "register_location" | "observe" | "qualify" | "prepare_offer" | "stop";
export type WebsiteSalesIrelandCommand = {
  contractVersion: typeof websiteSalesIrelandContract;
  operation: Operation;
  projectId: string;
  companyId: string;
  locationId?: string;
  locationVersion?: number;
  expectedVersion?: number;
  idempotencyKey: string;
  correlationId: string;
  payload: Record<string, unknown>;
};
type Scope = { projectId: string; companyId: string; locationId: string };
type LocationRow = {
  id: string; workspaceId: string; projectId: string; companyId: string; locationKey: string;
  countryCode: "IE"; address: string; sourceUrl: string; version: number;
};
type WorkflowRow = {
  id: string; workspaceId: string; projectId: string; companyId: string; locationId: string;
  locationVersion: number; observationId: string; version: number;
  status: "OBSERVED" | "QUALIFIED" | "OFFER_DRAFT" | "STOPPED";
  contactId: string | null; leadId: string | null; dealId: string | null; nextTaskId: string | null;
  offerDraftId: string | null; stopReason: string | null; createdAt: string | Date;
  lastCommandId: string; lastCorrelationId: string;
  prospect: unknown; investmentPlan: unknown; evidenceDigest: string; observedAt: string | Date;
};
const locationSelect = `select id,workspace_id as "workspaceId",project_id as "projectId",company_id as "companyId",
  location_key as "locationKey",country_code as "countryCode",address,source_url as "sourceUrl",version from crm_company_locations`;
const workflowSelect = `select w.id,w.workspace_id as "workspaceId",w.project_id as "projectId",w.company_id as "companyId",
  w.location_id as "locationId",w.location_version as "locationVersion",w.observation_id as "observationId",w.version,w.status,
  w.contact_id as "contactId",w.lead_id as "leadId",w.deal_id as "dealId",w.next_task_id as "nextTaskId",w.offer_draft_id as "offerDraftId",
  w.stop_reason as "stopReason",w.created_at as "createdAt",w.last_command_id as "lastCommandId",w.last_correlation_id as "lastCorrelationId",
  o.prospect,o.investment_plan as "investmentPlan",o.evidence_digest as "evidenceDigest",o.observed_at as "observedAt"
  from crm_website_sales_workflows w join crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.id=w.observation_id`;

function fail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\p{Cc}\p{Cf}]/u.test(value)) fail(`INVALID_${label}`, 400);
  return value.trim();
}
function publicUrl(raw: unknown): string {
  const value = text(raw, 2048, "SOURCE_URL");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":")) fail("INVALID_SOURCE_URL", 400);
    return url.href;
  } catch { return fail("INVALID_SOURCE_URL", 400); }
}
function qualification(raw: unknown): WebsiteProspectQualification {
  try { return qualifyWebsiteProspect(raw, new Date().toISOString()); }
  catch { return fail("INVALID_PROSPECT", 400); }
}
function validateCommand(raw: WebsiteSalesIrelandCommand): WebsiteSalesIrelandCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST", 400);
  assertCrmFields(raw as unknown as Record<string, unknown>, ["contractVersion", "operation", "projectId", "companyId", "locationId", "locationVersion", "expectedVersion", "idempotencyKey", "correlationId", "payload"]);
  if (raw.contractVersion !== websiteSalesIrelandContract || !["register_location", "observe", "qualify", "prepare_offer", "stop"].includes(raw.operation)) fail("INVALID_REQUEST", 400);
  assertCrmUuid(raw.projectId, "projectId"); assertCrmUuid(raw.companyId, "companyId");
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) fail("INVALID_PAYLOAD", 400);
  if (raw.operation === "register_location") {
    if (raw.locationId !== undefined || raw.locationVersion !== undefined || raw.expectedVersion !== undefined) fail("INVALID_LOCATION_REGISTRATION", 400);
    assertCrmFields(raw.payload, ["countryCode", "address", "sourceUrl", "sourceReference"]);
  } else {
    assertCrmUuid(raw.locationId, "locationId");
    if (raw.operation === "observe") {
      assertExpectedVersion(raw.locationVersion);
      if (raw.expectedVersion !== undefined) assertExpectedVersion(raw.expectedVersion);
      assertCrmFields(raw.payload, ["prospect", "investmentPlan"]);
    } else {
      assertExpectedVersion(raw.expectedVersion);
      if (raw.locationVersion !== undefined) fail("UNKNOWN_FIELD", 400);
      assertCrmFields(raw.payload, raw.operation === "qualify" ? ["contactId", "opportunitySummary", "nextAction", "expectedEvidenceDigest"]
        : raw.operation === "prepare_offer" ? ["content", "expectedEvidenceDigest"] : ["reason", "sourceReference"]);
    }
  }
  return raw;
}
async function company(tx: TenantTransaction, session: AppSession, scope: Pick<Scope, "projectId" | "companyId">) {
  await assertProjectGrant(tx, session, scope.projectId);
  // Keep the canonical offer repository's business-lock order. An organization SHARE lock here
  // would later require an UPDATE upgrade while another branch command holds the same SHARE.
  // Location composite FKs preserve project/company identity; classification and division stay guarded.
  const row = await tx.queryOne<{ name: string }>(`select o.name from organizations o join projects p on p.workspace_id=o.workspace_id and p.id=o.project_id
    where o.workspace_id=$1 and o.id=$2 and o.project_id=$3 and p.division='WEB_DESIGN'
      and o.data_classification='NOVALURE_INTERNAL' and p.data_classification='NOVALURE_INTERNAL'`,
  [session.workspaceId, scope.companyId, scope.projectId]);
  if (!row) fail("COMPANY_SCOPE_DENIED", 403);
  return row;
}
async function location(tx: TenantTransaction, session: AppSession, scope: Scope, lock = false) {
  if (lock) await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`website-sales-location:${session.workspaceId}:${scope.locationId}`]);
  const row = await tx.queryOne<LocationRow>(`${locationSelect} where workspace_id=$1 and project_id=$2 and company_id=$3 and id=$4`,
  [session.workspaceId, scope.projectId, scope.companyId, scope.locationId]);
  if (!row || row.countryCode !== "IE") fail("LOCATION_SCOPE_DENIED", 403);
  return { ...row, version: Number(row.version) };
}
async function workflow(tx: TenantTransaction, session: AppSession, scope: Scope, lock = false) {
  const row = await tx.queryOne<WorkflowRow>(`${workflowSelect} where w.workspace_id=$1 and w.project_id=$2 and w.company_id=$3 and w.location_id=$4 ${lock ? "for update of w" : ""}`,
  [session.workspaceId, scope.projectId, scope.companyId, scope.locationId]);
  return row ? { ...row, version: Number(row.version), locationVersion: Number(row.locationVersion) } : null;
}
async function qualifiedPipelineStage(tx: TenantTransaction, session: AppSession, projectId: string) {
  // CRM kanban binds deals through project_id and the exact configured stage name;
  // deals deliberately have no pipeline_id/stage_id columns. Resolve the existing
  // project's canonical default pipeline instead of manufacturing a stage label.
  const stages = await tx.query<{ id: string; pipelineId: string; name: string; key: string; category: string }>(`select s.id,cp.id as "pipelineId",s.name,s.key,s.category
    from projects p join crm_pipelines cp on cp.workspace_id=p.workspace_id and cp.project_id=p.id and cp.id=p.default_pipeline_id
    join crm_pipeline_stages s on s.workspace_id=cp.workspace_id and s.project_id=p.id and s.pipeline_id=cp.id
    where p.workspace_id=$1 and p.id=$2 and p.division='WEB_DESIGN' and cp.division='WEB_DESIGN'
    order by s.position,s.id for share of s,cp`, [session.workspaceId, projectId]);
  const open = stages.filter(stage => !["won", "lost", "disqualified"].includes(stage.category.toLowerCase()));
  if (!open.length) fail("PROJECT_PIPELINE_REQUIRED");
  const qualify = open.find(stage => ["qualify", "qualified"].includes(stage.key.toLowerCase()) || ["qualifizieren", "qualifiziert"].includes(stage.name.toLowerCase()));
  return qualify ?? open[0]!;
}
function bindProspect(current: WebsiteProspectQualification, session: AppSession, scope: Scope) {
  const id = current.identity;
  if (id.workspaceId !== session.workspaceId || id.projectId !== scope.projectId || id.companyId !== scope.companyId || id.locationId !== scope.locationId) fail("PROSPECT_SCOPE_DENIED", 403);
}
async function contactStop(tx: TenantTransaction, session: AppSession, row: WorkflowRow): Promise<string | null> {
  if (!row.contactId) return null;
  const contact = await tx.queryOne<{ consent: string; archived: string | null }>(`select consent_label as consent,archived_at as archived from contacts
    where workspace_id=$1 and id=$2 and organization_id=$3 and project_id=$4`, [session.workspaceId, row.contactId, row.companyId, row.projectId]);
  if (!contact || contact.archived) return "CONTACT_UNAVAILABLE";
  if (/(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)/i.test(contact.consent)) return "OPT_OUT";
  const stopped = await tx.queryOne<{ reason: string }>(`select stop_reason as reason from crm_website_sales_workflows
    where workspace_id=$1 and contact_id=$2 and status='STOPPED' and stop_reason in('OPT_OUT','REPLY_RECEIVED','UNKNOWN_DELIVERY')
    order by case stop_reason when 'OPT_OUT' then 0 when 'UNKNOWN_DELIVERY' then 1 else 2 end limit 1`, [session.workspaceId, row.contactId]);
  if (stopped) return stopped.reason;
  const blocked = await tx.queryOne<{ reason: string }>(`select 'OPT_OUT'::text as reason where exists(
    select 1 from consent_records where workspace_id=$1 and contact_id=$2 and status ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)')
    or exists(select 1 from newsletter_suppressions s join contacts c on c.workspace_id=s.workspace_id and lower(c.email)=lower(s.email)
      where c.workspace_id=$1 and c.id=$2)
    union all select 'REPLY_RECEIVED'::text where crm_website_sales_has_reply($1,$4,$2,$3::timestamptz) limit 1`,
  [session.workspaceId, row.contactId, row.createdAt, row.projectId]);
  return blocked?.reason ?? null;
}
async function view(tx: TenantTransaction, session: AppSession, scope: Scope, registered?: LocationRow) {
  const currentLocation = registered ?? await location(tx, session, scope);
  const row = await workflow(tx, session, scope);
  if (!row) return { location: currentLocation, workflow: null, canContact: false as const };
  const current = qualification(row.prospect);
  bindProspect(current, session, scope);
  const investmentDecision = row.investmentPlan === null ? null : decideWebsiteInvestment(row.investmentPlan, current, new Date().toISOString());
  const blockedReason = row.status === "STOPPED" ? row.stopReason : await contactStop(tx, session, row)
    ?? (row.locationVersion !== currentLocation.version ? "LOCATION_CHANGED" : current.status !== "READY" ? "STALE_OR_UNQUALIFIED_EVIDENCE" : null);
  return { location: currentLocation, workflow: {
    id: row.id, workspaceId: session.workspaceId, ...scope, locationVersion: row.locationVersion, version: row.version,
    status: row.status, blockedReason, evidenceDigest: current.evidenceDigest, qualificationStatus: current.status,
    validUntil: current.validUntil, investmentDecision, contactId: row.contactId, leadId: row.leadId, dealId: row.dealId,
    nextTaskId: row.nextTaskId, offerDraftId: row.offerDraftId, stopReason: row.stopReason,
    lastCommandId: row.lastCommandId, lastCorrelationId: row.lastCorrelationId, canContact: false as const,
  }, canContact: false as const };
}
export async function getWebsiteSalesIrelandWorkflow(session: AppSession, scope: Scope, options: TenantTransactionOptions = {}) {
  websiteSalesActorAuthority(session, scope, "read");
  assertCrmUuid(scope.projectId); assertCrmUuid(scope.companyId); assertCrmUuid(scope.locationId);
  return withCrmRead(session, async (tx, fresh) => {
    const canonicalCompany = await company(tx, fresh, scope);
    return { ...await view(tx, fresh, scope), companyName: canonicalCompany.name };
  }, options);
}
function offerKey(key: string) {
  const hash = createHash("sha256").update(`website-sales-offer:${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function updateWorkflow(tx: TenantTransaction, context: CrmCommandContext, row: WorkflowRow, patch: string, values: unknown[]) {
  const changed = await tx.queryOne(`update crm_website_sales_workflows set ${patch},version=version+1,last_command_id=$4,last_correlation_id=$5,updated_at=now()
    where workspace_id=$1 and id=$2 and version=$3 returning id`,
  [context.workspaceId, row.id, row.version, context.commandId, context.correlationId, ...values]);
  if (!changed) fail("VERSION_CONFLICT");
}

/** Shared exact command identity for execution and effect-free receipt lookup. */
export function websiteSalesIrelandCommandInput(session: AppSession, raw: WebsiteSalesIrelandCommand) {
  const input = validateCommand(raw);
  const machine = websiteSalesActorAuthority(session, input, input.operation);
  return { operation: `website_sales.ireland.${input.operation}`, projectId: input.projectId,
    resourceId: input.locationId ?? input.companyId, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, capability: "pipeline:write" as const,
    payload: machine ? { request: input, machine } : input };
}

/** Reads the original receipt only, then projects current evidence/stop state. Never invokes an effect. */
export async function reconcileWebsiteSalesIrelandCommand(session: AppSession, raw: WebsiteSalesIrelandCommand, options: TenantTransactionOptions = {}) {
  const command = websiteSalesIrelandCommandInput(session, raw);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    await company(tx, fresh, raw);
    const receipt = await reconcileCrmCommand<{ location: LocationRow; workflow: unknown; canContact: false }>(fresh, command, options);
    if (receipt.status === "NOT_FOUND") return receipt;
    // Registration receipts also bind their generated location to the still-current company.
    const scope = { projectId: raw.projectId, companyId: raw.companyId,
      locationId: raw.locationId ?? receipt.data.location.id };
    const currentData = await view(tx, fresh, scope);
    return { ...receipt, currentData };
  }, options);
}

/** Existing sessions or the dedicated verified Sales contract; one canonical CRM transaction. */
export async function runWebsiteSalesIrelandCommand(session: AppSession, raw: WebsiteSalesIrelandCommand, options: TenantTransactionOptions = {}) {
  const input = validateCommand(raw);
  const command = websiteSalesIrelandCommandInput(session, input);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    const canonicalCompany = await company(tx, fresh, input);
    if (input.operation === "register_location") {
      if (input.payload.countryCode !== "IE") fail("IRELAND_REQUIRED", 400);
      const address = text(input.payload.address, 1000, "ADDRESS");
      if (address.length < 5) fail("INVALID_ADDRESS", 400);
      const sourceUrl = publicUrl(input.payload.sourceUrl);
      const sourceReference = text(input.payload.sourceReference, 2000, "SOURCE_REFERENCE");
      const locationKey = crmPayloadDigest({ companyId: input.companyId, country: "IE", address: address.normalize("NFKC").toLocaleLowerCase("en-IE").replace(/\s+/g, " ") });
      const result = await executeCrmCommand(fresh, command, async (commandTx) => {
        const existing = await commandTx.queryOne<LocationRow>(`${locationSelect} where workspace_id=$1 and company_id=$2 and location_key=$3`, [fresh.workspaceId, input.companyId, locationKey]);
        if (existing) return { location: { ...existing, version: Number(existing.version) }, workflow: null, canContact: false as const };
        const id = randomUUID();
        await commandTx.execute(`insert into crm_company_locations(id,workspace_id,project_id,company_id,location_key,country_code,address,source_url,source_reference,registered_by,registration_basis)
          values($1,$2,$3,$4,$5,'IE',$6,$7,$8,$9,$10)`, [id, fresh.workspaceId, input.projectId, input.companyId, locationKey, address, sourceUrl, sourceReference, fresh.userId,
          fresh.serviceIdentity ? "REGISTERED_DELEGATION" : "SESSION_ATTESTED"]);
        return { location: await location(commandTx, fresh, { ...input, locationId: id }), workflow: null, canContact: false as const };
      }, options);
      return result;
    }
    const scope: Scope = { projectId: input.projectId, companyId: input.companyId, locationId: input.locationId! };
    // A location lock serializes different idempotency keys for the same physical branch.
    const registered = await location(tx, fresh, scope, true);
    const result = await executeCrmCommand(fresh, command, async (commandTx, context) => {
      const row = await workflow(commandTx, fresh, scope, true);
      if (input.operation === "observe") {
        if (registered.version !== input.locationVersion) fail("LOCATION_VERSION_CONFLICT");
        if (row && (row.version !== input.expectedVersion || row.status !== "OBSERVED")) fail(row.status === "STOPPED" ? "WORKFLOW_STOPPED" : "VERSION_OR_STATE_CONFLICT");
        if (!row && input.expectedVersion !== undefined) fail("VERSION_CONFLICT");
        const current = qualification(input.payload.prospect);
        bindProspect(current, fresh, scope);
        let investmentDecision = null;
        if (input.payload.investmentPlan !== undefined) {
          try { investmentDecision = decideWebsiteInvestment(input.payload.investmentPlan, current, new Date().toISOString()); }
          catch { fail("INVALID_INVESTMENT_PLAN", 400); }
        }
        const observedAt = new Date(Math.max(...current.input.evidence.map(item => Date.parse(item.observedAt)))).toISOString();
        if (row && Date.parse(observedAt) <= new Date(row.observedAt).valueOf()) fail("STALE_OBSERVATION");
        const observationId = randomUUID();
        await commandTx.execute(`insert into crm_website_sales_observations(id,workspace_id,project_id,company_id,location_id,location_version,evidence_digest,prospect,observed_at,valid_until,recorded_by,investment_plan,investment_decision)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb)`, [observationId, fresh.workspaceId, scope.projectId, scope.companyId, scope.locationId,
          registered.version, current.evidenceDigest, JSON.stringify(current.input), observedAt, current.validUntil, fresh.userId,
          investmentDecision === null ? null : JSON.stringify(input.payload.investmentPlan), investmentDecision === null ? null : JSON.stringify(investmentDecision)]);
        if (row) await updateWorkflow(commandTx, context, row, "observation_id=$6", [observationId]);
        else await commandTx.execute(`insert into crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,location_version,observation_id,last_command_id,last_correlation_id)
          values($1,$2,$3,$4,$5,$6,$7,$8)`, [fresh.workspaceId, scope.projectId, scope.companyId, scope.locationId, registered.version, observationId, context.commandId, context.correlationId]);
      } else {
        if (!row) fail("WORKFLOW_NOT_FOUND", 404);
        if (row.version !== input.expectedVersion) fail("VERSION_CONFLICT");
        if (row.status === "STOPPED") fail("WORKFLOW_STOPPED");
        if (input.operation === "stop") {
          if (!["REPLY_RECEIVED", "OPT_OUT", "NO_FIT", "STALE_EVIDENCE", "UNKNOWN_DELIVERY"].includes(String(input.payload.reason))) fail("INVALID_STOP_REASON", 400);
          const reference = text(input.payload.sourceReference, 2000, "SOURCE_REFERENCE");
          if (row.nextTaskId) await commandTx.execute(`update tasks set status='done',version=version+1,metadata=metadata || $3::jsonb,updated_at=now()
            where workspace_id=$1 and id=$2 and project_id=$4 and status='open'`, [fresh.workspaceId, row.nextTaskId, JSON.stringify({ stopped: true, stopReason: input.payload.reason, sourceReference: reference }), scope.projectId]);
          await updateWorkflow(commandTx, context, row, "status='STOPPED',stop_reason=$6,stop_source_reference=$7", [input.payload.reason, reference]);
        } else {
          const current = qualification(row.prospect);
          bindProspect(current, fresh, scope);
          if (registered.version !== row.locationVersion || current.status !== "READY" || current.evidenceDigest !== row.evidenceDigest ||
            input.payload.expectedEvidenceDigest !== current.evidenceDigest) fail("CURRENT_EVIDENCE_REQUIRED");
          const stopped = await contactStop(commandTx, fresh, row);
          if (stopped) fail(stopped);
          if (input.operation === "qualify") {
            if (row.status !== "OBSERVED") fail("INVALID_WORKFLOW_STATE");
            const contactId = assertCrmUuid(input.payload.contactId, "contactId");
            const contact = await commandTx.queryOne<{ id: string; consent: string }>(`select id,consent_label as consent from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 and archived_at is null for update`,
            [fresh.workspaceId, scope.projectId, scope.companyId, contactId]);
            if (!contact) fail("CONTACT_SCOPE_DENIED", 403);
            const provisional = { ...row, contactId };
            const contactBlocked = await contactStop(commandTx, fresh, provisional);
            if (contactBlocked) fail(contactBlocked);
            const summary = text(input.payload.opportunitySummary, 2000, "OPPORTUNITY_SUMMARY");
            const nextAction = text(input.payload.nextAction, 1000, "NEXT_ACTION");
            const stage = await qualifiedPipelineStage(commandTx, fresh, scope.projectId);
            const leadId = randomUUID(), dealId = randomUUID(), taskId = randomUUID();
            const provenance = JSON.stringify({ websiteSalesWorkflowId: row.id, companyId: scope.companyId, locationId: scope.locationId,
              observationId: row.observationId, evidenceDigest: current.evidenceDigest, contactBasis: "NONE", outboundEnabled: false,
              websiteSalesPipeline: { pipelineId: stage.pipelineId, stageId: stage.id, stageName: stage.name } });
            await commandTx.execute(`insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status,score,intent,next_action,sales_qualification,metadata,division)
              values($1,$2,$3,$4,$5,'Website Sales Ireland research','Website','Qualifiziert',0,$6,$7,$8::jsonb,$9::jsonb,'WEB_DESIGN')`,
            [leadId, fresh.workspaceId, scope.projectId, contactId, fresh.userId, summary, nextAction,
              JSON.stringify({ source: "website-sales-ireland-v1", evidenceDigest: current.evidenceDigest, path: current.input.path, qualification: "research_only", scoreBasis: "NOT_COMPUTED" }), provenance]);
            await commandTx.execute(`insert into deals(id,workspace_id,project_id,contact_id,organization_id,owner_user_id,lead_id,name,stage,source,next_action,metadata,division)
              values($1,$2,$3,$4,$5,$6,$7,$8,$11,'Website Sales Ireland research',$9,$10::jsonb,'WEB_DESIGN')`,
            [dealId, fresh.workspaceId, scope.projectId, contactId, scope.companyId, fresh.userId, leadId, `${canonicalCompany.name}: Website Ireland`.slice(0, 240), nextAction, provenance, stage.name]);
            await commandTx.execute(`insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,priority,status,metadata)
              values($1,$2,$3,$4,$5,$6,$7,'Normal','open',$8::jsonb)`, [taskId, fresh.workspaceId, scope.projectId, contactId, leadId, fresh.userId, `Internal research review: ${nextAction}`.slice(0, 500), provenance]);
            await updateWorkflow(commandTx, context, row, "status='QUALIFIED',contact_id=$6,lead_id=$7,deal_id=$8,next_task_id=$9", [contactId, leadId, dealId, taskId]);
          } else {
            if (row.status !== "QUALIFIED") fail("INVALID_WORKFLOW_STATE");
            let content;
            try { content = parseOfferContent(input.payload.content); }
            catch (error) { if (error instanceof OfferValidationError) fail(error.code, 400); throw error; }
            // Match the existing offer writer: deal -> contact -> lead -> organization.
            // A contact-first prelock can deadlock with that writer on the same deal.
            const deal = await commandTx.queryOne<{ version: number }>(`select version from deals where workspace_id=$1 and id=$2 and project_id=$3 and contact_id=$4 and organization_id=$5 and lead_id=$6 for update`,
            [fresh.workspaceId, row.dealId, scope.projectId, row.contactId, scope.companyId, row.leadId]);
            if (!deal) fail("DEAL_SCOPE_DENIED", 403);
            const contact = await commandTx.queryOne<{ email: string | null; name: string }>(`select email,name from contacts where workspace_id=$1 and id=$2 and project_id=$3 and organization_id=$4 and archived_at is null for update`,
            [fresh.workspaceId, row.contactId, scope.projectId, scope.companyId]);
            if (!contact || content.recipientEmail !== contact.email?.trim().toLowerCase() || content.recipientName !== contact.name.trim()) fail("CANONICAL_RECIPIENT_REQUIRED");
            const lead = await commandTx.queryOne(`select id from leads where workspace_id=$1 and id=$2 and project_id=$3 and contact_id=$4 for update`,
            [fresh.workspaceId, row.leadId, scope.projectId, row.contactId]);
            if (!lead) fail("LEAD_SCOPE_DENIED", 403);
            const organization = await commandTx.queryOne(`select id from organizations where workspace_id=$1 and id=$2 and project_id=$3 for update`,
            [fresh.workspaceId, scope.companyId, scope.projectId]);
            if (!organization) fail("COMPANY_SCOPE_DENIED", 403);
            // Waiting for business locks must not preserve an earlier readiness/consent snapshot.
            const effective = qualification(row.prospect);
            if (effective.status !== "READY" || effective.evidenceDigest !== row.evidenceDigest) fail("CURRENT_EVIDENCE_REQUIRED");
            const currentStop = await contactStop(commandTx, fresh, row);
            if (currentStop) fail(currentStop);
            const offer = await executeOfferCommand(fresh, { operation: "create", projectId: scope.projectId, dealId: row.dealId!,
              expectedVersion: Number(deal.version), idempotencyKey: offerKey(input.idempotencyKey), correlationId: input.correlationId, payload: { content, leadId: row.leadId } }, options);
            await updateWorkflow(commandTx, context, row, "status='OFFER_DRAFT',offer_draft_id=$6", [offer.data.id]);
          }
        }
      }
      return view(commandTx, fresh, scope, registered);
    }, options);
    // Stored receipt replay skips the callback. Re-evaluate current scope, evidence, reply and opt-out state
    // before returning a result; an old receipt never resurrects historical workflow readiness.
    return { ...result, data: await view(tx, fresh, scope, registered) };
  }, options);
}
