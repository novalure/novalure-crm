import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppSession } from "../auth/session";
import { CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand,
  withCrmCommandPreflight, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { websiteSalesActorAuthority, withWebsiteSalesLifecycleStop } from "../website-sales-machine-authority";
import { decideWebsiteInvestment, qualifyWebsiteProspect } from "../website-prospect";
import { verifyWebsiteStudioArtifact, type WebsiteStudioArtifact } from "../website-sales-studio";
import { verifyWebsiteStudioQaCertificate } from "../website-sales-studio-qa";
import { websiteSalesLifecycleContract, type WebsiteSalesLifecycleCommand, type WebsiteSalesLifecycleScope,
  type WebsiteSalesLifecycleEffect, type WebsiteSalesLifecycleRead, type WebsiteSalesCustomerAcceptance,
  type WebsiteSalesReplyClassification } from "../website-sales-lifecycle-types";
import { runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, websiteSalesIrelandState } from "./website-sales-ireland-repositories";

const uuid = z.uuid(), text = z.string().trim().min(1).max(2000), strings = z.array(text).min(1).max(20);
const payloads = {
  refresh_evidence: z.strictObject({ prospect: z.unknown(), locationVersion: z.number().int().positive(), investmentPlan: z.unknown().optional() }),
  authorize_reply_classification: z.strictObject({ canonicalMessageId: uuid, allowBoundedClassification: z.boolean() }),
  ingest_reply: z.strictObject({ canonicalMessageId: uuid }),
  record_customer_acceptance: z.strictObject({ conceptArtifactId: uuid, demoArtifactId: uuid, sourceReference: text.min(5),
    included: strings, excluded: strings, acceptanceCriteria: strings, prerequisites: strings }),
  create_handoff: z.strictObject({ customerAcceptanceId: uuid, pmOwnerId: uuid.optional() }),
};
const commandSchema = z.strictObject({ contractVersion: z.literal(websiteSalesLifecycleContract),
  operation: z.enum(["refresh_evidence", "authorize_reply_classification", "ingest_reply", "record_customer_acceptance", "create_handoff"]),
  projectId: uuid, companyId: uuid, locationId: uuid, expectedVersion: z.number().int().positive(),
  idempotencyKey: z.uuidv4(), correlationId: uuid, payload: z.record(z.string(), z.unknown()) });
function fail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
export function parseWebsiteSalesLifecycleCommand(raw: unknown): WebsiteSalesLifecycleCommand {
  const result = commandSchema.safeParse(raw); if (!result.success) fail("INVALID_LIFECYCLE_COMMAND", 400);
  const payload = payloads[result.data.operation].safeParse(result.data.payload); if (!payload.success) fail("INVALID_LIFECYCLE_PAYLOAD", 400);
  return { ...result.data, payload: payload.data };
}
export function websiteSalesLifecycleCommandInput(session: AppSession, raw: WebsiteSalesLifecycleCommand) {
  const input = parseWebsiteSalesLifecycleCommand(raw);
  const machine = websiteSalesActorAuthority(session, input, input.operation, "lifecycle");
  if (session.serviceIdentity && ["authorize_reply_classification", "record_customer_acceptance"].includes(input.operation)) fail("HUMAN_ATTESTATION_REQUIRED", 403);
  return { operation: `website_sales.lifecycle.${input.operation}`, projectId: input.projectId, resourceId: input.locationId,
    expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    capability: "pipeline:write" as const, payload: { request: raw, machine } };
}
type State = Awaited<ReturnType<typeof websiteSalesIrelandState>>;
type Row = NonNullable<State["row"]>;
type InboundSource = { messageId: string; sourceUserId: string; receivedAt: Date | string; sourceHash: string;
  classification: WebsiteSalesReplyClassification; bodyShared: boolean; canAuthorizeClassification: boolean };
async function inbound(tx: TenantTransaction, session: AppSession, row: Row, messageId: string | null = null) {
  return tx.query<InboundSource>(`select message_id as "messageId",source_user_id as "sourceUserId",received_at as "receivedAt",source_hash as "sourceHash",
    classification,body_shared as "bodyShared",can_authorize as "canAuthorizeClassification"
    from crm_website_sales_inbound_source($1,$2,$3,$4)`, [session.workspaceId, row.projectId, row.id, messageId]);
}
function workflow(state: State) { if (!state.row || !state.current.workflow) fail("WORKFLOW_NOT_FOUND", 404); return state.current.workflow; }
async function read(tx: TenantTransaction, session: AppSession, scope: WebsiteSalesLifecycleScope): Promise<WebsiteSalesLifecycleRead> {
  const state = await websiteSalesIrelandState(tx, session, scope), current = workflow(state), row = state.row!;
  const inboundCandidates = (await inbound(tx, session, row)).map(source => ({ messageId: source.messageId,
    receivedAt: new Date(source.receivedAt).toISOString(), sourceHash: source.sourceHash, classification: source.classification,
    bodyShared: source.bodyShared, canAuthorizeClassification: source.canAuthorizeClassification }));
  const responses = await tx.query<WebsiteSalesLifecycleRead["responses"][number]>(`select id,message_id as "messageId",classification,classification_basis as "classificationBasis",
    next_task_id as "nextTaskId",late,created_at::text as "createdAt" from crm_website_sales_inbound_events where workspace_id=$1 and workflow_id=$2 order by created_at desc,id desc limit 25`, [session.workspaceId, row.id]);
  const saved = await tx.query<{ id: string; version: number; current: boolean; conceptArtifactId: string; demoArtifactId: string; sourceReference: string; scope: Pick<WebsiteSalesCustomerAcceptance, "included" | "excluded" | "acceptanceCriteria" | "prerequisites">; createdAt: string }>(`select a.id,a.version,
    a.evidence_digest=$3 and not exists(select 1 from crm_website_sales_customer_acceptances newer where newer.workspace_id=a.workspace_id and newer.workflow_id=a.workflow_id and newer.version>a.version) as current,
    a.concept_artifact_id as "conceptArtifactId",a.demo_artifact_id as "demoArtifactId",a.source_reference as "sourceReference",a.scope,a.created_at::text as "createdAt"
    from crm_website_sales_customer_acceptances a where a.workspace_id=$1 and a.workflow_id=$2 order by a.version desc limit 25`, [session.workspaceId, row.id, row.evidenceDigest]);
  const handoffs = await tx.query<WebsiteSalesLifecycleRead["handoffs"][number]>(`select h.id,h.customer_acceptance_id as "customerAcceptanceId",h.task_id as "taskId",h.snapshot_digest as "snapshotDigest",h.created_at::text as "createdAt",
    a.evidence_digest=$3 and not exists(select 1 from crm_website_sales_customer_acceptances newer where newer.workspace_id=a.workspace_id and newer.workflow_id=a.workflow_id and newer.version>a.version) as current
    from crm_website_sales_handoffs h join crm_website_sales_customer_acceptances a on a.workspace_id=h.workspace_id and a.id=h.customer_acceptance_id
    where h.workspace_id=$1 and h.workflow_id=$2 order by h.created_at desc,h.id desc limit 25`, [session.workspaceId, row.id, row.evidenceDigest]);
  const allowed = await tx.queryOne<{ allowed: boolean }>("select crm_project_access($1,$2,true) as allowed", [session.workspaceId, scope.projectId]);
  return { contractVersion: websiteSalesLifecycleContract, source: "database", workspaceId: session.workspaceId, ...scope,
    workflow: current, inboundCandidates, responses, customerAcceptances: saved.map(({ scope: acceptedScope, ...acceptance }) => ({ ...acceptance, ...acceptedScope, attestationKind: "OPERATOR_RECORDED_CUSTOMER_ACCEPTANCE" })), handoffs,
    canWrite: !!allowed?.allowed && session.permissions.includes("crm:write") && session.productPermissions.includes("pipeline:write"), canContact: false };
}
export async function readWebsiteSalesLifecycle(session: AppSession, scope: WebsiteSalesLifecycleScope, options: TenantTransactionOptions = {}) {
  websiteSalesActorAuthority(session, scope, "read", "lifecycle");
  return withCrmRead(session, (tx, fresh) => read(tx, fresh, scope), options);
}
function childKey(key: string) { const h = createHash("sha256").update(`website-sales-lifecycle-stop:${key}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function ready(state: State, allowReply = false) {
  const row = state.row!; const current = qualifyWebsiteProspect(row.prospect, new Date().toISOString());
  if (current.status !== "READY" || current.evidenceDigest !== row.evidenceDigest || row.locationVersion !== state.location.version) fail("CURRENT_EVIDENCE_REQUIRED");
  if (state.contactStop && !(allowReply && state.contactStop === "REPLY_RECEIVED")) fail(state.contactStop);
  if (row.status === "STOPPED" && !(allowReply && row.stopReason === "REPLY_RECEIVED")) fail("WORKFLOW_STOPPED");
  return current;
}
type ArtifactRow = { id: string; createdBy: string; artifact: WebsiteStudioArtifact };
async function acceptedArtifacts(tx: TenantTransaction, session: AppSession, row: Row, conceptId: string, demoId: string) {
  const selected = await tx.query<ArtifactRow>(`select id,created_by as "createdBy",artifact from crm_website_studio_artifacts
    where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=any($6::uuid[])`,
  [session.workspaceId, row.projectId, row.companyId, row.locationId, row.id, [conceptId, demoId]]);
  const conceptRow = selected.find(a => a.id === conceptId), demoRow = selected.find(a => a.id === demoId);
  if (!conceptRow || !demoRow) fail("CURRENT_ACCEPTED_DEMO_REQUIRED");
  const concept = verifyWebsiteStudioArtifact(conceptRow.artifact, qualifyWebsiteProspect(row.prospect, new Date().toISOString()).input, new Date().toISOString());
  const demo = verifyWebsiteStudioArtifact(demoRow.artifact, qualifyWebsiteProspect(row.prospect, new Date().toISOString()).input, new Date().toISOString());
  if (concept.kind !== "CONCEPT" || demo.kind !== "DEMO" || demo.parentArtifactDigest !== concept.artifactDigest) fail("CURRENT_ACCEPTED_DEMO_REQUIRED");
  if (await tx.queryOne(`select id from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2
    and ((kind='CONCEPT' and version>$3) or(kind='DEMO' and version>$4) or(kind='DIAGNOSIS' and artifact_digest<>$5)) limit 1`,
  [session.workspaceId, row.id, concept.version, demo.version, concept.parentArtifactDigest])) {
    const latestDiagnosis = await tx.queryOne<{ digest: string }>("select artifact_digest as digest from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and kind='DIAGNOSIS' order by version desc limit 1", [session.workspaceId, row.id]);
    const newer = await tx.queryOne("select id from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and((kind='CONCEPT' and version>$3)or(kind='DEMO' and version>$4)) limit 1", [session.workspaceId, row.id, concept.version, demo.version]);
    if (newer || latestDiagnosis?.digest !== concept.parentArtifactDigest) fail("STUDIO_PARENT_CHANGED");
  }
  const accepted = await tx.queryOne("select id from crm_website_studio_acceptances where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and artifact_id=$6 and id=$7", [session.workspaceId, row.projectId, row.companyId, row.locationId, row.id, conceptId, demo.content.acceptanceId]);
  if (!accepted) fail("CURRENT_ACCEPTED_DEMO_REQUIRED");
  const certificates = await tx.query<{ certificate: unknown }>("select certificate from crm_website_studio_qa where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and artifact_id=$6 and expires_at>now() order by expires_at desc limit 20", [session.workspaceId, row.projectId, row.companyId, row.locationId, row.id, demoId]);
  let qaCertificateId: string | null = null;
  for (const candidate of certificates) { try { qaCertificateId = verifyWebsiteStudioQaCertificate(candidate.certificate, demo, row.id, demoRow.createdBy).payload.certificateId; break; } catch { /* Try the next current, independently signed certificate. */ } }
  if (!qaCertificateId) fail("SIGNED_RENDERED_QA_REQUIRED");
  return { concept, demo, qaCertificateId };
}

export async function executeWebsiteSalesLifecycleCommand(session: AppSession, raw: WebsiteSalesLifecycleCommand, options: TenantTransactionOptions = {}) {
  const input = parseWebsiteSalesLifecycleCommand(raw), command = websiteSalesLifecycleCommandInput(session, raw);
  return withCrmCommandPreflight(session, command, async (outer, fresh) => {
    const result = await executeCrmCommand(fresh, command, async (tx, context): Promise<WebsiteSalesLifecycleEffect> => {
      const state = await websiteSalesIrelandState(tx, context.session, input, true), row = state.row;
      if (!row) fail("WORKFLOW_NOT_FOUND", 404);
      if (row.version !== input.expectedVersion) fail("VERSION_CONFLICT");
      const p = input.payload;
      if (input.operation === "refresh_evidence") {
        if (!["QUALIFIED", "OFFER_DRAFT"].includes(row.status)) fail("INVALID_REFRESH_STATE");
        if (state.contactStop) fail(state.contactStop);
        if (p.locationVersion !== state.location.version) fail("LOCATION_VERSION_CONFLICT");
        const assessed = qualifyWebsiteProspect(p.prospect, new Date().toISOString()), id = assessed.identity;
        if (id.workspaceId !== fresh.workspaceId || id.projectId !== row.projectId || id.companyId !== row.companyId || id.locationId !== row.locationId) fail("PROSPECT_SCOPE_DENIED", 403);
        const observedAt = Math.max(...assessed.input.evidence.map(e => Date.parse(e.observedAt)));
        if (observedAt <= new Date(row.observedAt).valueOf() || Date.parse(assessed.validUntil) <= Date.now()) fail("NEWER_CURRENT_OBSERVATION_REQUIRED");
        // Existing canonical offer actions lock the deal/offer before subsequent business rows.
        const deal = await tx.queryOne(`select id from deals where workspace_id=$1 and project_id=$2 and id=$3 and contact_id=$4 and lead_id=$5 and organization_id=$6 for update`, [fresh.workspaceId, row.projectId, row.dealId, row.contactId, row.leadId, row.companyId]);
        if (!deal) fail("DEAL_SCOPE_DENIED", 403);
        const offer = await tx.queryOne<{ id: string; revision: number; contentDigest: string; status: string; approvalId: string | null }>(`select o.id,o.revision,r.content_digest as "contentDigest",o.status,o.approval_id as "approvalId" from crm_offers o
          join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
          where o.workspace_id=$1 and o.deal_id=$2 for update of o`, [fresh.workspaceId, row.dealId]);
        if (offer && (offer.id !== row.offerDraftId || offer.status !== "DRAFT" || offer.approvalId
          || await tx.queryOne("select id from crm_offer_approvals where workspace_id=$1 and offer_id=$2 and decision='APPROVED' limit 1", [fresh.workspaceId, offer.id])
          || await tx.queryOne("select id from crm_offer_deliveries where workspace_id=$1 and offer_id=$2 limit 1", [fresh.workspaceId, offer.id]))) fail("OFFER_REVIEW_REQUIRED");
        const contact = await tx.queryOne("select id from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4 and archived_at is null for update", [fresh.workspaceId, row.projectId, row.companyId, row.contactId]);
        if (!contact) fail("CONTACT_SCOPE_DENIED", 403);
        const locked = await websiteSalesIrelandState(tx, fresh, input);
        if (locked.contactStop) fail(locked.contactStop);
        let investmentDecision = null;
        if (p.investmentPlan !== undefined) investmentDecision = decideWebsiteInvestment(p.investmentPlan, assessed, new Date().toISOString());
        const observationId = randomUUID(), refreshId = randomUUID();
        await tx.execute(`insert into crm_website_sales_observations(id,workspace_id,project_id,company_id,location_id,location_version,evidence_digest,prospect,observed_at,valid_until,recorded_by,investment_plan,investment_decision)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb)`, [observationId, fresh.workspaceId, row.projectId, row.companyId, row.locationId, state.location.version,
          assessed.evidenceDigest, JSON.stringify(assessed.input), new Date(observedAt).toISOString(), assessed.validUntil, fresh.userId,
          p.investmentPlan === undefined ? null : JSON.stringify(p.investmentPlan), investmentDecision === null ? null : JSON.stringify(investmentDecision)]);
        await tx.execute(`insert into crm_website_sales_refreshes(id,workspace_id,project_id,company_id,location_id,workflow_id,old_observation_id,new_observation_id,evidence_digest,created_by)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [refreshId, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, row.observationId, observationId, assessed.evidenceDigest, fresh.userId]);
        if (offer) await tx.execute(`insert into crm_website_sales_offer_invalidations(id,workspace_id,project_id,refresh_id,offer_id,revision,content_digest) values($1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id,offer_id,revision) do nothing`, [randomUUID(), fresh.workspaceId, row.projectId, refreshId, offer.id, offer.revision, offer.contentDigest]);
        const provenance = JSON.stringify({ websiteSalesEvidenceDigest: assessed.evidenceDigest, websiteSalesObservationId: observationId, websiteSalesRefreshId: refreshId, outboundEnabled: false });
        for (const [table, entityId] of [["leads", row.leadId], ["deals", row.dealId], ["tasks", row.nextTaskId]]) {
          await tx.execute(`update ${table} set metadata=metadata||$4::jsonb,version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and id=$3`, [fresh.workspaceId, row.projectId, entityId, provenance]);
        }
        await tx.execute(`update crm_website_sales_workflows set observation_id=$4,location_version=$5,status='QUALIFIED',version=version+1,last_command_id=$6,last_correlation_id=$7,updated_at=now()
          where workspace_id=$1 and id=$2 and version=$3`, [fresh.workspaceId, row.id, input.expectedVersion, observationId, state.location.version, context.commandId, context.correlationId]);
        return { refreshId, newObservationId: observationId, invalidatedOfferId: offer?.id ?? null, workflow: workflow(await websiteSalesIrelandState(tx, fresh, input)) };
      }
      if (input.operation === "authorize_reply_classification") {
        if (fresh.serviceIdentity) fail("HUMAN_ATTESTATION_REQUIRED", 403);
        const source = (await inbound(tx, fresh, row, String(p.canonicalMessageId)))[0];
        if (!source || source.sourceUserId !== fresh.userId || !source.canAuthorizeClassification) fail("PERSONAL_MESSAGE_OWNER_REQUIRED", 403);
        const prior = await tx.queryOne<{ id: string; version: number; active: boolean }>(`select p.id,p.version,p.expires_at>now() and not exists(select 1 from crm_website_sales_reply_revocations r where r.workspace_id=p.workspace_id and r.permission_id=p.id) as active
          from crm_website_sales_reply_permissions p where p.workspace_id=$1 and p.workflow_id=$2 and p.message_id=$3 order by p.version desc limit 1`, [fresh.workspaceId, row.id, source.messageId]);
        let id = prior?.id ?? randomUUID();
        if (p.allowBoundedClassification === false) {
          if (!prior) fail("CLASSIFICATION_PERMISSION_NOT_FOUND", 404);
          await tx.execute("insert into crm_website_sales_reply_revocations(id,workspace_id,project_id,permission_id,revoked_by) values($1,$2,$3,$4,$5) on conflict(workspace_id,permission_id) do nothing", [randomUUID(), fresh.workspaceId, row.projectId, prior.id, fresh.userId]);
        } else if (!prior?.active) {
          id = randomUUID();
          await tx.execute(`insert into crm_website_sales_reply_permissions(id,workspace_id,project_id,company_id,location_id,workflow_id,source_user_id,message_id,authorized_by,purpose,version,expires_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$7,'BOUNDED_CLASSIFICATION_ONLY',$9,now()+interval '24 hours')`, [id, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, fresh.userId, source.messageId, Number(prior?.version ?? 0)+1]);
        }
        return { replyPermissionId: id, messageId: source.messageId, workflow: workflow(state) };
      }
      if (input.operation === "ingest_reply") {
        const source = (await inbound(tx, fresh, row, String(p.canonicalMessageId)))[0]; if (!source) fail("CANONICAL_REPLY_NOT_AVAILABLE", 403);
        const prior = await tx.queryOne<{ id: string; classification: WebsiteSalesReplyClassification; nextTaskId: string | null }>("select id,classification,next_task_id as \"nextTaskId\" from crm_website_sales_inbound_events where workspace_id=$1 and workflow_id=$2 and message_id=$3", [fresh.workspaceId, row.id, source.messageId]);
        if (prior) return { responseId: prior.id, messageId: source.messageId, classification: prior.classification, nextTaskId: prior.nextTaskId, workflow: workflow(state) };
        const rate = await tx.queryOne<{ n: number }>("select count(*)::int as n from crm_website_sales_inbound_events where workspace_id=$1 and workflow_id=$2 and created_at>now()-interval '1 minute'", [fresh.workspaceId, row.id]);
        if ((rate?.n ?? 0) >= 25) fail("REPLY_RATE_LIMIT", 429);
        const latest = await tx.queryOne<{ receivedAt: string }>("select received_at::text as \"receivedAt\" from crm_website_sales_inbound_events where workspace_id=$1 and workflow_id=$2 order by received_at desc limit 1", [fresh.workspaceId, row.id]);
        const late = !!latest && new Date(source.receivedAt).valueOf() < Date.parse(latest.receivedAt);
        if (source.classification === "OPT_OUT") {
          await tx.execute("update contacts set consent_label='Abgemeldet',version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4", [fresh.workspaceId, row.projectId, row.companyId, row.contactId]);
          await tx.execute("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source,metadata) values($1,$2,$3,'E-Mail','Abgemeldet','website-sales-canonical-inbound',$4::jsonb)", [fresh.workspaceId, row.projectId, row.contactId, JSON.stringify({ canonicalMessageId: source.messageId, sourceHash: source.sourceHash })]);
        }
        if (row.status !== "STOPPED") await withWebsiteSalesLifecycleStop(fresh, () => runWebsiteSalesIrelandCommand(fresh, {
          contractVersion: websiteSalesIrelandContract, operation: "stop", projectId: row.projectId, companyId: row.companyId, locationId: row.locationId,
          expectedVersion: row.version, idempotencyKey: childKey(input.idempotencyKey), correlationId: input.correlationId,
          payload: { reason: source.classification === "OPT_OUT" ? "OPT_OUT" : "REPLY_RECEIVED", sourceReference: `crm-mailbox-message:${source.messageId}:${source.sourceHash}` },
        }, options));
        const responseId = randomUUID(), nextTaskId = source.classification === "OPT_OUT" || late ? null : randomUUID();
        if (nextTaskId) await tx.execute(`insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,priority,status,metadata)
          values($1,$2,$3,$4,$5,$6,$7,'Normal','open',$8::jsonb)`, [nextTaskId, fresh.workspaceId, row.projectId, row.contactId, row.leadId, fresh.userId,
          source.classification === "OUT_OF_OFFICE" ? "Review out-of-office timing; no interest assumed" : source.classification === "QUESTION" ? "Clarify the customer's question" : "Review canonical reply; confirm intent manually",
          JSON.stringify({ websiteSalesWorkflowId: row.id, responseId, canonicalMessageId: source.messageId, classification: source.classification, reviewRequired: true, outboundEnabled: false })]);
        await tx.execute(`insert into crm_website_sales_inbound_events(id,workspace_id,project_id,company_id,location_id,workflow_id,source_user_id,message_id,source_hash,classification,received_at,late,next_task_id,created_by)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [responseId, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, source.sourceUserId, source.messageId, source.sourceHash, source.classification, source.receivedAt, late, nextTaskId, fresh.userId]);
        return { responseId, messageId: source.messageId, classification: source.classification, nextTaskId, workflow: workflow(await websiteSalesIrelandState(tx, fresh, input)) };
      }
      ready(state, true);
      if (input.operation === "record_customer_acceptance") {
        if (fresh.serviceIdentity) fail("HUMAN_ATTESTATION_REQUIRED", 403);
        const artifacts = await acceptedArtifacts(tx, fresh, row, String(p.conceptArtifactId), String(p.demoArtifactId));
        const acceptedScope = { included: p.included, excluded: p.excluded, acceptanceCriteria: p.acceptanceCriteria, prerequisites: p.prerequisites };
        const acceptanceDigest = crmPayloadDigest({ workflowId: row.id, conceptDigest: artifacts.concept.artifactDigest, demoDigest: artifacts.demo.artifactDigest, sourceReference: p.sourceReference, scope: acceptedScope });
        const latest = await tx.queryOne<{ id: string; version: number; digest: string }>("select id,version,acceptance_digest as digest from crm_website_sales_customer_acceptances where workspace_id=$1 and workflow_id=$2 order by version desc limit 1", [fresh.workspaceId, row.id]);
        const unchanged = latest?.digest === acceptanceDigest, id = unchanged ? latest.id : randomUUID();
        if (!unchanged) {
          await tx.execute(`insert into crm_website_sales_customer_acceptances(id,workspace_id,project_id,company_id,location_id,workflow_id,concept_artifact_id,demo_artifact_id,concept_digest,demo_digest,evidence_digest,source_reference,scope,accepted_by,acceptance_digest,version)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`, [id, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, p.conceptArtifactId, p.demoArtifactId,
          artifacts.concept.artifactDigest, artifacts.demo.artifactDigest, row.evidenceDigest, p.sourceReference, JSON.stringify(acceptedScope), fresh.userId, acceptanceDigest, Number(latest?.version ?? 0)+1]);
          await tx.execute(`update tasks set metadata=metadata||$3::jsonb,version=version+1,updated_at=now()
            where workspace_id=$1 and status='open' and id in(select task_id from crm_website_sales_handoffs where workspace_id=$1 and workflow_id=$2)`,
          [fresh.workspaceId, row.id, JSON.stringify({ websiteSalesHandoffStatus: "SUPERSEDED_SCOPE_REVIEW_REQUIRED", supersededByAcceptanceId: id })]);
          await tx.execute("update crm_website_sales_workflows set version=version+1,last_command_id=$4,last_correlation_id=$5,updated_at=now() where workspace_id=$1 and id=$2 and version=$3", [fresh.workspaceId, row.id, row.version, context.commandId, context.correlationId]);
        }
        return { customerAcceptanceId: id, workflow: workflow(await websiteSalesIrelandState(tx, fresh, input)) };
      }
      const acceptance = await tx.queryOne<{ id: string; conceptId: string; demoId: string; conceptDigest: string; demoDigest: string; evidenceDigest: string; sourceReference: string; scope: unknown; acceptedBy: string }>(`select id,concept_artifact_id as "conceptId",demo_artifact_id as "demoId",concept_digest as "conceptDigest",demo_digest as "demoDigest",evidence_digest as "evidenceDigest",source_reference as "sourceReference",scope,accepted_by as "acceptedBy"
        from crm_website_sales_customer_acceptances a where workspace_id=$1 and workflow_id=$2 and id=$3
          and not exists(select 1 from crm_website_sales_customer_acceptances newer where newer.workspace_id=a.workspace_id and newer.workflow_id=a.workflow_id and newer.version>a.version)`, [fresh.workspaceId, row.id, p.customerAcceptanceId]);
      if (!acceptance || acceptance.evidenceDigest !== row.evidenceDigest) fail("CURRENT_CUSTOMER_ACCEPTANCE_REQUIRED");
      const artifacts = await acceptedArtifacts(tx, fresh, row, acceptance.conceptId, acceptance.demoId);
      if (artifacts.concept.artifactDigest !== acceptance.conceptDigest || artifacts.demo.artifactDigest !== acceptance.demoDigest) fail("CURRENT_CUSTOMER_ACCEPTANCE_REQUIRED");
      const previous = await tx.queryOne<{ id: string; taskId: string }>("select id,task_id as \"taskId\" from crm_website_sales_handoffs where workspace_id=$1 and customer_acceptance_id=$2", [fresh.workspaceId, acceptance.id]);
      if (previous) return { handoffId: previous.id, taskId: previous.taskId, customerAcceptanceId: acceptance.id, workflow: workflow(state) };
      let ownerId: string | null = null;
      if (p.pmOwnerId !== undefined) {
        const owner = await tx.queryOne<{ id: string }>(`select u.id from workspace_users u join project_pipeline_permissions p on p.workspace_id=u.workspace_id and p.user_id=u.id
          where u.workspace_id=$1 and u.id=$2 and p.project_id=$3 and p.can_read and u.status='active' and u.product_role not in('external_partner','client_viewer')`, [fresh.workspaceId, p.pmOwnerId, row.projectId]);
        if (!owner) fail("PM_OWNER_NOT_GRANTED", 403); ownerId = owner.id;
      }
      const id = randomUUID(), taskId = randomUUID();
      const snapshot = { workflowId: row.id, identity: { workspaceId: fresh.workspaceId, projectId: row.projectId, companyId: row.companyId, locationId: row.locationId },
        companyName: state.company.name, locationLabel: state.location.address, evidenceDigest: row.evidenceDigest, customerAcceptanceId: acceptance.id,
        attestationKind: "OPERATOR_RECORDED_CUSTOMER_ACCEPTANCE", acceptedBy: acceptance.acceptedBy, sourceReference: acceptance.sourceReference,
        conceptDigest: acceptance.conceptDigest, demoDigest: acceptance.demoDigest, qaCertificateId: artifacts.qaCertificateId,
        scope: acceptance.scope, assignedToUserId: ownerId, department: "PROJECT_MANAGEMENT", contractExecutionEnabled: false, invoiceEnabled: false, outboundEnabled: false };
      const snapshotDigest = crmPayloadDigest(snapshot);
      await tx.execute(`insert into tasks(id,workspace_id,project_id,contact_id,lead_id,owner_user_id,title,priority,status,metadata)
        values($1,$2,$3,$4,$5,$6,'Project management: review accepted Website Sales scope','Normal','open',$7::jsonb)`, [taskId, fresh.workspaceId, row.projectId, row.contactId, row.leadId, ownerId, JSON.stringify({ websiteSalesHandoffId: id, snapshotDigest, ...snapshot })]);
      await tx.execute(`insert into crm_website_sales_handoffs(id,workspace_id,project_id,company_id,location_id,workflow_id,customer_acceptance_id,task_id,snapshot,snapshot_digest,created_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [id, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, acceptance.id, taskId, JSON.stringify(snapshot), snapshotDigest, fresh.userId]);
      return { handoffId: id, taskId, customerAcceptanceId: acceptance.id, workflow: workflow(state) };
    }, options);
    return { ...result, data: { ...result.data, workflow: workflow(await websiteSalesIrelandState(outer, fresh, input)) } };
  }, options);
}
export async function reconcileWebsiteSalesLifecycleCommand(session: AppSession, raw: WebsiteSalesLifecycleCommand, options: TenantTransactionOptions = {}) {
  const input = parseWebsiteSalesLifecycleCommand(raw), command = websiteSalesLifecycleCommandInput(session, raw);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    const currentData = await read(tx, fresh, input);
    const receipt = await reconcileCrmCommand<WebsiteSalesLifecycleEffect>(fresh, command, options);
    return receipt.status === "COMMITTED" ? { ...receipt, currentData } : receipt;
  }, options);
}
