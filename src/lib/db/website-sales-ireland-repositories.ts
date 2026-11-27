import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { CRM_MACHINE_WORKSPACE_ID } from "@/lib/crm-machine-auth";
import {
  assertCrmFields, assertCrmUuid, assertExpectedVersion, assertProjectGrant,
  CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead,
  type CrmCommandContext, type TenantTransaction, type TenantTransactionOptions,
} from "@/lib/crm-command";
import { qualifyWebsiteProspect, type WebsiteProspectQualification } from "@/lib/website-prospect";
import { websiteSalesActorAuthority, websiteSalesStudioAuthority } from "@/lib/website-sales-machine-authority";
import { assertStudioAcceptedTransfer } from "@/lib/studio-source-reader";
import { studioEnquiryCrmProject } from "@/lib/studio-enquiry-contract";
import { attachWebsiteSalesInbound, lockWebsiteSalesInboundDeal } from "./website-sales-inbound-repository";

export const websiteSalesIrelandContract = "website-sales-ireland-v1";
export const websiteSalesIrelandPath = "/api/crm/website-sales";
type Operation = "register_location" | "observe" | "qualify" | "stop";
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
type StudioTransferReference = {
  sourceGrantId: string; operationId: string; revision: number; payloadHash: string; leadId: string; submissionId: string;
};
type LocationRow = {
  id: string; workspaceId: string; projectId: string; companyId: string; locationKey: string;
  countryCode: "IE"; address: string; sourceUrl: string; sourceReference: string; version: number;
};
type WorkflowRow = {
  id: string; workspaceId: string; projectId: string; companyId: string; locationId: string;
  locationVersion: number; observationId: string; version: number;
  status: "OBSERVED" | "QUALIFIED" | "STOPPED";
  contactId: string | null; leadId: string | null; dealId: string | null; nextTaskId: string | null;
  stopReason: string | null; createdAt: string | Date;
  lastCommandId: string; lastCorrelationId: string;
  prospect: unknown; evidenceDigest: string; observedAt: string | Date;
};
const locationSelect = `select id,workspace_id as "workspaceId",project_id as "projectId",company_id as "companyId",
  location_key as "locationKey",country_code as "countryCode",address,source_url as "sourceUrl",source_reference as "sourceReference",version from crm_company_locations`;
const workflowSelect = `select w.id,w.workspace_id as "workspaceId",w.project_id as "projectId",w.company_id as "companyId",
  w.location_id as "locationId",w.location_version as "locationVersion",w.observation_id as "observationId",w.version,w.status,
  w.contact_id as "contactId",w.lead_id as "leadId",w.deal_id as "dealId",w.next_task_id as "nextTaskId",
  w.stop_reason as "stopReason",w.created_at as "createdAt",w.last_command_id as "lastCommandId",w.last_correlation_id as "lastCorrelationId",
  o.prospect,o.evidence_digest as "evidenceDigest",o.observed_at as "observedAt"
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
function studioTransferReference(value: unknown): StudioTransferReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("STUDIO_TRANSFER_REQUIRED", 400);
  const fields = value as Record<string, unknown>;
  assertCrmFields(fields, ["sourceGrantId", "operationId", "revision", "payloadHash", "leadId", "submissionId"]);
  for (const field of ["sourceGrantId", "operationId", "leadId", "submissionId"] as const) assertCrmUuid(fields[field], field);
  if (typeof fields.revision !== "number" || !Number.isInteger(fields.revision) || fields.revision < 1 ||
    fields.revision > 2147483647 || typeof fields.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(fields.payloadHash)) {
    fail("INVALID_STUDIO_TRANSFER", 400);
  }
  return fields as StudioTransferReference;
}
export function validateWebsiteSalesIrelandCommand(raw: WebsiteSalesIrelandCommand): WebsiteSalesIrelandCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST", 400);
  assertCrmFields(raw as unknown as Record<string, unknown>, ["contractVersion", "operation", "projectId", "companyId", "locationId", "locationVersion", "expectedVersion", "idempotencyKey", "correlationId", "payload"]);
  if (raw.contractVersion !== websiteSalesIrelandContract || !["register_location", "observe", "qualify", "stop"].includes(raw.operation)) fail("INVALID_REQUEST", 400);
  assertCrmUuid(raw.projectId, "projectId"); assertCrmUuid(raw.companyId, "companyId");
  if (raw.projectId !== studioEnquiryCrmProject) fail("SALES_RESOURCE_DENIED", 403);
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) fail("INVALID_PAYLOAD", 400);
  if (raw.operation === "register_location") {
    if (raw.locationId !== undefined || raw.locationVersion !== undefined || raw.expectedVersion !== undefined) fail("INVALID_LOCATION_REGISTRATION", 400);
    assertCrmFields(raw.payload, ["countryCode", "address", "sourceUrl", "sourceReference"]);
  } else {
    assertCrmUuid(raw.locationId, "locationId");
    if (raw.operation === "observe") {
      assertExpectedVersion(raw.locationVersion);
      if (raw.expectedVersion !== undefined) assertExpectedVersion(raw.expectedVersion);
      assertCrmFields(raw.payload, ["prospect"]);
    } else {
      assertExpectedVersion(raw.expectedVersion);
      if (raw.locationVersion !== undefined) fail("UNKNOWN_FIELD", 400);
      assertCrmFields(raw.payload, raw.operation === "qualify" ? ["contactId", "opportunitySummary", "nextAction", "expectedEvidenceDigest", "studioTransfer"] : ["reason", "sourceReference"]);
      if (raw.operation === "qualify") {
        assertCrmUuid(raw.payload.contactId, "contactId");
        text(raw.payload.opportunitySummary, 2000, "OPPORTUNITY_SUMMARY");
        text(raw.payload.nextAction, 1000, "NEXT_ACTION");
        if (typeof raw.payload.expectedEvidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.payload.expectedEvidenceDigest)) fail("INVALID_EVIDENCE_DIGEST", 400);
        studioTransferReference(raw.payload.studioTransfer);
      }
    }
  }
  return raw;
}
async function company(tx: TenantTransaction, session: AppSession, scope: Pick<Scope, "projectId" | "companyId">) {
  if (session.workspaceId !== CRM_MACHINE_WORKSPACE_ID || scope.projectId !== studioEnquiryCrmProject) fail("SALES_RESOURCE_DENIED", 403);
  await assertProjectGrant(tx, session, scope.projectId);
  // Keep the canonical offer repository's business-lock order. An organization SHARE lock here
  // would later require an UPDATE upgrade while another branch command holds the same SHARE.
  // Location composite FKs preserve project/company identity; classification and division stay guarded.
  const row = await tx.queryOne<{ name: string }>(`select o.name from organizations o join projects p on p.workspace_id=o.workspace_id and p.id=o.project_id
    where o.workspace_id=$1 and o.id=$2 and o.project_id=$3 and o.division=p.division
      and o.data_classification='NOVALURE_INTERNAL' and p.data_classification='NOVALURE_INTERNAL'
      and o.data_purpose='crm_sales' and p.data_purpose='crm_sales'`,
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
    where p.workspace_id=$1 and p.id=$2 and cp.division=p.division
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
  const blocked = await tx.queryOne<{ optedOut: boolean; replied: boolean }>(`select (exists(
    select 1 from consent_records where workspace_id=$1 and contact_id=$2 and status ~* '(opt.?out|abgemeldet|unsubscribe|widerspruch|stop|^no$|^false$)')
    or exists(select 1 from newsletter_suppressions s join contacts c on c.workspace_id=s.workspace_id and lower(c.email)=lower(s.email)
      where c.workspace_id=$1 and c.id=$2)) as "optedOut",crm_website_sales_has_reply($1,$4,$2,$3::timestamptz) as replied`,
  [session.workspaceId, row.contactId, row.createdAt, row.projectId]);
  if (blocked?.optedOut || stopped?.reason === "OPT_OUT") return "OPT_OUT";
  if (stopped?.reason === "UNKNOWN_DELIVERY") return "UNKNOWN_DELIVERY";
  return stopped?.reason === "REPLY_RECEIVED" || blocked?.replied ? "REPLY_RECEIVED" : null;
}
async function view(tx: TenantTransaction, session: AppSession, scope: Scope, registered?: LocationRow) {
  const currentLocation = registered ?? await location(tx, session, scope);
  const row = await workflow(tx, session, scope);
  if (!row) return { location: currentLocation, workflow: null, canContact: false as const };
  const current = qualification(row.prospect);
  bindProspect(current, session, scope);
  const stopped = await contactStop(tx, session, row);
  const blockedReason = stopped === "OPT_OUT" || stopped === "UNKNOWN_DELIVERY" ? stopped : row.status === "STOPPED" ? row.stopReason : stopped
    ?? (row.locationVersion !== currentLocation.version ? "LOCATION_CHANGED" : current.status !== "READY" ? "STALE_OR_UNQUALIFIED_EVIDENCE" : null);
  return { location: currentLocation, workflow: {
    id: row.id, workspaceId: session.workspaceId, ...scope, locationVersion: row.locationVersion, version: row.version,
    status: row.status, blockedReason, evidenceDigest: current.evidenceDigest, qualificationStatus: current.status,
    validUntil: current.validUntil, contactId: row.contactId, leadId: row.leadId, dealId: row.dealId,
    nextTaskId: row.nextTaskId, stopReason: row.stopReason,
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
async function updateWorkflow(tx: TenantTransaction, context: CrmCommandContext, row: WorkflowRow, patch: string, values: unknown[]) {
  const changed = await tx.queryOne(`update crm_website_sales_workflows set ${patch},version=version+1,last_command_id=$4,last_correlation_id=$5,updated_at=now()
    where workspace_id=$1 and id=$2 and version=$3 returning id`,
  [context.workspaceId, row.id, row.version, context.commandId, context.correlationId, ...values]);
  if (!changed) fail("VERSION_CONFLICT");
}

/** Shared exact command identity for execution and effect-free receipt lookup. */
export function websiteSalesIrelandCommandInput(session: AppSession, raw: WebsiteSalesIrelandCommand) {
  const input = validateWebsiteSalesIrelandCommand(raw);
  const machine = websiteSalesActorAuthority(session, input, input.operation);
  if (input.operation === "qualify" && !machine) fail("SALES_MACHINE_AUTHORITY_REQUIRED", 403);
  return { operation: `website_sales.ireland.${input.operation}`, projectId: input.projectId,
    resourceId: input.locationId ?? input.companyId, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, capability: "pipeline:write" as const,
    payload: machine ? { request: input, machine } : input };
}

/** Resolve the original receipt under current Sales authority without rerunning qualification. */
export async function reconcileWebsiteSalesIrelandCommand(session: AppSession, raw: WebsiteSalesIrelandCommand, options: TenantTransactionOptions = {}) {
  const command = websiteSalesIrelandCommandInput(session, raw);
  if (raw.operation !== "qualify") fail("INVALID_REQUEST", 400);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    await company(tx, fresh, raw);
    await location(tx, fresh, { ...raw, locationId: raw.locationId! });
    return reconcileCrmCommand<{ location: LocationRow; workflow: unknown; canContact: false }>(fresh, command, options);
  }, options);
}

export async function runWebsiteSalesIrelandCommand(session: AppSession, raw: WebsiteSalesIrelandCommand, options: TenantTransactionOptions = {}) {
  const input = validateWebsiteSalesIrelandCommand(raw);
  const command = websiteSalesIrelandCommandInput(session, input);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    await company(tx, fresh, input);
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
          values($1,$2,$3,$4,$5,'IE',$6,$7,$8,$9,'SESSION_ATTESTED')`, [id, fresh.workspaceId, input.projectId, input.companyId, locationKey, address, sourceUrl, sourceReference, fresh.userId]);
        return { location: await location(commandTx, fresh, { ...input, locationId: id }), workflow: null, canContact: false as const };
      }, options);
      return result;
    }
    const scope: Scope = { projectId: input.projectId, companyId: input.companyId, locationId: input.locationId! };
    // A location lock serializes different idempotency keys for the same physical branch.
    const registered = await location(tx, fresh, scope, true);
    const studioTransfer = input.operation === "qualify" ? studioTransferReference(input.payload.studioTransfer) : null;
    const checkStudioTransfer = async () => {
      if (!studioTransfer) return null;
      const { sourceGrantId, ...proof } = studioTransfer;
      return assertStudioAcceptedTransfer(tx, {
        ...proof, workspaceId: fresh.workspaceId, crmProjectId: scope.projectId,
      }, websiteSalesStudioAuthority(fresh, scope, sourceGrantId));
    };
    const confirmedSubmission = await checkStudioTransfer();
    const result = await executeCrmCommand(fresh, command, async (commandTx, context) => {
      const row = await workflow(commandTx, fresh, scope, true);
      if (input.operation === "observe") {
        if (registered.version !== input.locationVersion) fail("LOCATION_VERSION_CONFLICT");
        if (row && (row.version !== input.expectedVersion || row.status !== "OBSERVED")) fail(row.status === "STOPPED" ? "WORKFLOW_STOPPED" : "VERSION_OR_STATE_CONFLICT");
        if (!row && input.expectedVersion !== undefined) fail("VERSION_CONFLICT");
        const current = qualification(input.payload.prospect);
        bindProspect(current, fresh, scope);
        const observedAt = new Date(Math.max(...current.input.evidence.map(item => Date.parse(item.observedAt)))).toISOString();
        if (row && Date.parse(observedAt) <= new Date(row.observedAt).valueOf()) fail("STALE_OBSERVATION");
        const observationId = randomUUID();
        await commandTx.execute(`insert into crm_website_sales_observations(id,workspace_id,project_id,company_id,location_id,location_version,evidence_digest,prospect,observed_at,valid_until,recorded_by)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, [observationId, fresh.workspaceId, scope.projectId, scope.companyId, scope.locationId,
          registered.version, current.evidenceDigest, JSON.stringify(current.input), observedAt, current.validUntil, fresh.userId]);
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
          if (!studioTransfer || !confirmedSubmission || row.status !== "OBSERVED") fail("INVALID_WORKFLOW_STATE");
          const contactId = assertCrmUuid(input.payload.contactId, "contactId");
          if (confirmedSubmission.contactId !== contactId) fail("STUDIO_INBOUND_CONTACT_CONFLICT");
          // Match the offer writer's lock order: Deal → Contact → Lead.
          const inbound = await lockWebsiteSalesInboundDeal(commandTx, fresh, scope, contactId, studioTransfer.leadId, confirmedSubmission.dealId);
          const contact = await commandTx.queryOne<{ id: string }>(`select id from contacts
            where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 and archived_at is null
              and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for update`,
          [fresh.workspaceId, scope.projectId, scope.companyId, contactId]);
          if (!contact) fail("CONTACT_SCOPE_DENIED", 403);
          const nextAction = text(input.payload.nextAction, 1000, "NEXT_ACTION");
          const summary = text(input.payload.opportunitySummary, 2000, "OPPORTUNITY_SUMMARY");
          const stage = await qualifiedPipelineStage(commandTx, fresh, scope.projectId);
          const taskId = randomUUID();
          const provenance = JSON.stringify({ websiteSalesWorkflowId: row.id, companyId: scope.companyId, locationId: scope.locationId,
            observationId: row.observationId, evidenceDigest: current.evidenceDigest, studioTransferOperationId: studioTransfer.operationId,
            contactBasis: "NONE", outboundEnabled: false, opportunitySummary: summary,
            websiteSalesPipeline: { pipelineId: stage.pipelineId, stageId: stage.id, stageName: stage.name } });
          const effective = qualification(row.prospect);
          if (effective.status !== "READY" || effective.evidenceDigest !== current.evidenceDigest) fail("CURRENT_EVIDENCE_REQUIRED");
          const contactBlocked = await contactStop(commandTx, fresh, { ...row, contactId });
          if (contactBlocked) fail(contactBlocked);
          await attachWebsiteSalesInbound(commandTx, fresh, scope, contactId, inbound, provenance);
          await commandTx.execute(`insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,priority,status,metadata)
            values($1,$2,$3,$4,$5,$6,$7,'Normal','open',$8::jsonb)`, [taskId, fresh.workspaceId, scope.projectId, contactId, inbound.leadId,
            fresh.userId, `Internal research review: ${nextAction}`.slice(0, 500), provenance]);
          await updateWorkflow(commandTx, context, row, "status='QUALIFIED',contact_id=$6,lead_id=$7,deal_id=$8,next_task_id=$9,studio_operation_id=$10",
            [contactId, inbound.leadId, inbound.dealId, taskId, studioTransfer.operationId]);
        }
      }
      return view(commandTx, fresh, scope, registered);
    }, options);
    if (confirmedSubmission) {
      const currentSubmission = await checkStudioTransfer();
      if (currentSubmission?.contactId !== confirmedSubmission.contactId || currentSubmission?.dealId !== confirmedSubmission.dealId)
        fail("STUDIO_INBOUND_CHANGED");
    }
    // Keep the command receipt stable across later workflow stops.
    return result;
  }, options);
}
