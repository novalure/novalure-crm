import { getOfferApprovalReference } from "./approval-reference-repositories";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertExpectedVersion, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { assertFreshOfferSession, assertOfferApproval, nextOfferStatus, offerDate, offerText, offerTotal, parseOfferContent, OfferValidationError, type OfferAction, type OfferContent, type OfferStatus } from "@/lib/offer-workflow";
import { evaluateOutboundConsent } from "@/lib/db/consent-policy";

type OfferRow = { id: string; workspaceId: string; projectId: string; dealId: string; contactId: string; leadId: string; organizationId: string; status: OfferStatus; revision: number; version: number; approvalId: string | null; followUpStatus: string; followUpAt: string | null; responseReference: string | null; content: OfferContent; contentDigest: string; totalNetCents: string | number };
type ApprovalRow = { id: string; revision: number; digest: string; actorId: string; expiresAt: string; decision: string };
export type OfferCommand = { operation: "create" | OfferAction; offerId?: string; dealId?: string; projectId: string; expectedVersion?: number; idempotencyKey: string; correlationId: string; payload: Record<string, unknown> };
const selectOffer = `select o.id,o.workspace_id as "workspaceId",o.project_id as "projectId",o.deal_id as "dealId",o.contact_id as "contactId",o.lead_id as "leadId",o.organization_id as "organizationId",o.status,o.revision,o.version,o.approval_id as "approvalId",o.follow_up_status as "followUpStatus",o.follow_up_at as "followUpAt",o.response_reference as "responseReference",r.content,r.content_digest as "contentDigest",r.total_net_cents as "totalNetCents" from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision`;
function error(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
function normalize(row: OfferRow) { return { ...row, version: Number(row.version), revision: Number(row.revision), totalNetCents: Number(row.totalNetCents) }; }
function fields(payload: Record<string, unknown>, allowed: string[]) { if (Object.keys(payload).some(key => !allowed.includes(key))) error("UNKNOWN_OFFER_FIELD", 400); }
async function approvalConfig(tx: TenantTransaction, session: AppSession) {
  const row = await tx.queryOne<{ approverId: string | null }>(`select crm_offer_configured_approver($1::uuid) as "approverId"`, [session.workspaceId]);
  return row?.approverId ?? null;
}
async function freshApproverSession(tx: TenantTransaction, session: AppSession) {
  if (!session.authSessionId || !session.authIdentityId) error("FRESH_AUTHENTICATION_REQUIRED", 401);
  const active = await tx.queryOne<{ createdAt: string }>(`select created_at as "createdAt" from auth_sessions where id=$1::uuid and auth_identity_id=$2::uuid and workspace_user_id=$3::uuid and workspace_id=$4::uuid and revoked_at is null and expires_at>now()`, [session.authSessionId, session.authIdentityId, session.userId, session.workspaceId]);
  if (!active) error("FRESH_AUTHENTICATION_REQUIRED", 401);
  assertFreshOfferSession({ ...session, sessionCreatedAt: active.createdAt }, Date.now());
}
async function assertCloseGrant(tx: TenantTransaction, session: AppSession, projectId: string) {
  const row = await tx.queryOne<{ allowed: boolean }>(`select crm_workspace_manager($1::uuid) or exists(select 1 from project_pipeline_permissions where workspace_id=$1::uuid and project_id=$2::uuid and user_id=$3::uuid and can_edit_deals and can_close_deals) as allowed`, [session.workspaceId, projectId, session.userId]);
  if (!row?.allowed) error("DEAL_CLOSE_PERMISSION_REQUIRED", 403);
}
async function currentApproval(tx: TenantTransaction, offer: OfferRow) {
  return offer.approvalId ? tx.queryOne<ApprovalRow>(`select id,revision,content_digest as digest,actor_id as "actorId",expires_at as "expiresAt",decision from crm_offer_approvals where workspace_id=$1::uuid and id=$2::uuid and offer_id=$3::uuid`, [offer.workspaceId, offer.approvalId, offer.id]) : null;
}
async function requireApproval(tx: TenantTransaction, offer: OfferRow, session: AppSession) {
  const approval = await currentApproval(tx, offer);
  if (!approval || approval.decision !== "APPROVED") error("VALID_APPROVAL_REQUIRED");
  assertOfferApproval({ revision: offer.revision, digest: offer.contentDigest, approverId: approval.actorId, configuredApproverId: await approvalConfig(tx, session), approval, now: Date.now() });
  const reference = await getOfferApprovalReference(session, approval.id);
  if (reference.status !== "APPROVED" || reference.scope.action !== "offer.send" || reference.scope.workspaceId !== offer.workspaceId || reference.scope.projectId !== offer.projectId || reference.scope.resourceId !== offer.id || reference.scope.resourceVersion !== offer.revision || reference.scope.contentDigest !== offer.contentDigest || reference.scope.recipient !== offer.content.recipientEmail || reference.scope.totalNetCents !== Number(offer.totalNetCents) || reference.requiredSteps !== 1) error("APPROVAL_SCOPE_MISMATCH");
  if (Date.parse(offer.content.validUntil) <= Date.now()) error("OFFER_EXPIRED");
  return approval;
}
async function revision(tx: TenantTransaction, offer: { id: string; workspaceId: string; projectId: string; contactId: string; leadId: string; organizationId: string }, number: number, content: OfferContent, actorId: string, requireFuture = true) {
  if (requireFuture && Date.parse(content.validUntil) <= Date.now()) error("OFFER_VALIDITY_MUST_BE_FUTURE", 400);
  const digest = crmPayloadDigest({ action: "offer.send", workspaceId: offer.workspaceId, projectId: offer.projectId, offerId: offer.id, revision: number, contactId: offer.contactId, leadId: offer.leadId, organizationId: offer.organizationId, content, totalNetCents: offerTotal(content) });
  await tx.execute(`insert into crm_offer_revisions(workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8::uuid)`, [offer.workspaceId, offer.projectId, offer.id, number, JSON.stringify(content), digest, offerTotal(content), actorId]);
  return digest;
}
async function stopTasks(tx: TenantTransaction, offer: OfferRow, reason: string) {
  await tx.execute(`update tasks set status='done',metadata=metadata || $3::jsonb,version=version+1,updated_at=now() where workspace_id=$1::uuid and metadata->>'offerId'=$2 and status='open'`, [offer.workspaceId, offer.id, JSON.stringify({ stopped: true, stopReason: reason })]);
}
async function readView(tx: TenantTransaction, session: AppSession, dealId: string) {
  const deal = await tx.queryOne<{ projectId: string; version: string | number }>(`select project_id as "projectId",version from deals where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, dealId]);
  if (!deal) error("DEAL_NOT_FOUND", 404);
  await assertProjectGrant(tx, session, deal.projectId);
  const row = await tx.queryOne<OfferRow>(`${selectOffer} where o.workspace_id=$1::uuid and o.deal_id=$2::uuid`, [session.workspaceId, dealId]);
  const approverId = await approvalConfig(tx, session);
  const deliveries = row ? await tx.query(`select id,revision,content_digest as "contentDigest",recipient_email as "recipientEmail",status,receipt_reference as "receiptReference",attested_by as "attestedBy",attested_at as "attestedAt",created_at as "createdAt" from crm_offer_deliveries where workspace_id=$1::uuid and offer_id=$2::uuid order by revision desc`, [session.workspaceId, row.id]) : [];
  return { approvalReference: row?.approvalId ? await getOfferApprovalReference(session, row.approvalId) : null, offer: row ? normalize(row) : null, approval: row ? await currentApproval(tx, row) : null, deliveries, approverConfigured: Boolean(approverId), canApprove: approverId === session.userId, dealVersion: Number(deal.version), deliverySemantics: "manual_attestation_only", contractExecutionEnabled: false };
}
export async function getOfferWorkflow(session: AppSession, dealId: string, options: TenantTransactionOptions = {}) {
  assertCrmUuid(dealId, "dealId");
  return withCrmRead(session, (tx, fresh) => readView(tx, fresh, dealId), options);
}

export async function executeOfferCommand(session: AppSession, input: OfferCommand, options: TenantTransactionOptions = {}) {
  try {
    if (!["create", "revise", "approve", "revoke", "queue_send", "record_sent", "record_unknown", "accept", "reject", "schedule_follow_up", "stop_follow_up", "complete_follow_up"].includes(input.operation)) error("OFFER_ACTION_DISABLED", 400);
    assertCrmUuid(input.projectId, "projectId");
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) error("INVALID_OFFER_PAYLOAD", 400);
    const expectedVersion = assertExpectedVersion(input.expectedVersion);
    return await executeCrmCommand(session, offerCommandInput(input), async (tx, context) => {
      const session = context.session;
      if (input.operation === "create") {
        fields(input.payload, ["content", "leadId", "organizationName"]);
        const content = parseOfferContent(input.payload.content);
        const deal = await tx.queryOne<{ id: string; projectId: string; contactId: string | null; leadId: string | null; organizationId: string | null; stage: string; version: number | string }>(`select id,project_id as "projectId",contact_id as "contactId",lead_id as "leadId",organization_id as "organizationId",stage,version from deals where workspace_id=$1::uuid and id=$2::uuid for update`, [session.workspaceId, input.dealId]);
        if (!deal || deal.projectId !== input.projectId) error("DEAL_NOT_FOUND", 404);
        if (Number(deal.version) !== expectedVersion) error("VERSION_CONFLICT");
        if (["Gewonnen", "Verloren", "Disqualifiziert", "Pausiert / Verloren"].includes(deal.stage)) error("DEAL_ALREADY_CLOSED");
        const duplicate = await tx.queryOne(`select id from crm_offers where workspace_id=$1::uuid and deal_id=$2::uuid`, [session.workspaceId, deal.id]);
        if (duplicate) error("OFFER_ALREADY_EXISTS");
        const contact = await tx.queryOne<{ id: string; projectId: string | null; organizationId: string | null }>(`select id,project_id as "projectId",organization_id as "organizationId" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null for update`, [session.workspaceId, deal.contactId]);
        if (!contact || contact.projectId !== deal.projectId) error("VALID_CONTACT_REQUIRED", 400);
        const leadId = assertCrmUuid(input.payload.leadId ?? deal.leadId, "leadId");
        const lead = await tx.queryOne(`select id from leads where workspace_id=$1::uuid and id=$2::uuid and project_id=$3::uuid and contact_id=$4::uuid for update`, [session.workspaceId, leadId, deal.projectId, contact.id]);
        if (!lead) error("VALID_LEAD_REQUIRED", 400);
        let organizationId = deal.organizationId ?? contact.organizationId;
        if (organizationId) {
          const organization = await tx.queryOne(`select id from organizations where workspace_id=$1::uuid and id=$2::uuid and (project_id is null or project_id=$3::uuid) for update`, [session.workspaceId, organizationId, deal.projectId]);
          if (!organization) error("VALID_ORGANIZATION_REQUIRED", 400);
          if (deal.organizationId && contact.organizationId && deal.organizationId !== contact.organizationId) error("ORGANIZATION_CONFLICT");
        } else {
          organizationId = randomUUID();
          await tx.execute(`insert into organizations(id,workspace_id,project_id,owner_user_id,name,type,lifecycle_stage) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Unternehmen','Lead')`, [organizationId, session.workspaceId, deal.projectId, session.userId, offerText(input.payload.organizationName, "ORGANIZATION_NAME", 240)]);
        }
        if (!contact.organizationId) await tx.execute(`update contacts set organization_id=$3::uuid,version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, contact.id, organizationId]);
        await tx.execute(`update deals set lead_id=$3::uuid,organization_id=$4::uuid,version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and version=$5`, [session.workspaceId, deal.id, leadId, organizationId, expectedVersion]);
        const id = randomUUID();
        await tx.execute(`insert into crm_offers(id,workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,created_by) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid)`, [id, session.workspaceId, deal.projectId, deal.id, contact.id, leadId, organizationId, session.userId]);
        await revision(tx, { id, workspaceId: session.workspaceId, projectId: deal.projectId, contactId: contact.id, leadId, organizationId }, 1, content, session.userId);
        return { id, ...(await readView(tx, session, deal.id)) };
      }
      const row = await tx.queryOne<OfferRow>(`${selectOffer} where o.workspace_id=$1::uuid and o.id=$2::uuid for update of o`, [session.workspaceId, input.offerId]);
      if (!row || row.projectId !== input.projectId) error("OFFER_NOT_FOUND", 404);
      const offer = normalize(row);
      if (offer.version !== expectedVersion) error("VERSION_CONFLICT");
      const status = nextOfferStatus(offer.status, input.operation);
      const payload = input.payload;
      if (input.operation === "revise") {
        fields(payload, ["content"]);
        await revision(tx, offer, offer.revision + 1, parseOfferContent(payload.content), session.userId);
        await stopTasks(tx, offer, "offer_revised");
        await tx.execute(`update crm_offers set revision=revision+1,approval_id=null,follow_up_status='STOPPED',follow_up_at=null,follow_up_reason='offer_revised' where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id]);
      } else if (input.operation === "approve") {
        fields(payload, ["expiresAt", "contentDigest", "revision"]);
        const approverId = await approvalConfig(tx, session);
        if (!approverId) error("APPROVER_NOT_CONFIGURED", 403);
        if (approverId !== session.userId) error("APPROVER_REQUIRED", 403);
        await freshApproverSession(tx, session);
        if (payload.contentDigest !== offer.contentDigest || payload.revision !== offer.revision) error("APPROVAL_SCOPE_MISMATCH");
        const expiresAt = offerDate(payload.expiresAt, "APPROVAL_EXPIRY");
        if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.parse(offer.content.validUntil)) error("INVALID_APPROVAL_EXPIRY", 400);
        const id = randomUUID();
        await tx.execute(`insert into crm_offer_approvals(id,workspace_id,project_id,offer_id,revision,content_digest,actor_id,auth_session_reference,decision,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::uuid,'APPROVED',$9::timestamptz)`, [id, session.workspaceId, offer.projectId, offer.id, offer.revision, offer.contentDigest, session.userId, session.authSessionId, expiresAt]);
        await tx.execute(`update crm_offers set approval_id=$3::uuid where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id, id]);
      } else if (input.operation === "revoke") {
        fields(payload, ["reason"]);
        if ((await approvalConfig(tx, session)) !== session.userId) error("APPROVER_REQUIRED", 403);
        await freshApproverSession(tx, session);
        const unknown = await tx.queryOne(`select id from crm_offer_deliveries where workspace_id=$1::uuid and offer_id=$2::uuid and revision=$3 and status='UNKNOWN'`, [session.workspaceId, offer.id, offer.revision]);
        if (unknown) error("DELIVERY_OUTCOME_UNKNOWN");
        offerText(payload.reason, "REVOKE_REASON", 2000);
        await tx.execute(`insert into crm_offer_approvals(workspace_id,project_id,offer_id,revision,content_digest,actor_id,auth_session_reference,decision,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid,'REVOKED',now())`, [session.workspaceId, offer.projectId, offer.id, offer.revision, offer.contentDigest, session.userId, session.authSessionId]);
        await tx.execute(`update crm_offer_deliveries set status='CANCELLED' where workspace_id=$1::uuid and offer_id=$2::uuid and revision=$3 and status='QUEUED'`, [session.workspaceId, offer.id, offer.revision]);
        await revision(tx, offer, offer.revision + 1, offer.content, session.userId, false);
        await tx.execute(`update crm_offers set approval_id=null,revision=revision+1 where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id]);
      } else if (input.operation === "queue_send") {
        fields(payload, []);
        const approval = await requireApproval(tx, offer, session);
        const consent = await evaluateOutboundConsent({ session, channel: "E-Mail", purpose: "salesFollowUp", contactId: offer.contactId, projectId: offer.projectId, email: offer.content.recipientEmail, metadata: { offerId: offer.id, revision: offer.revision } });
        if (!consent.allowed) error("OUTBOUND_CONSENT_REQUIRED", 403);
        await tx.execute(`insert into crm_offer_deliveries(workspace_id,project_id,offer_id,revision,content_digest,recipient_email,approval_id,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::uuid)`, [session.workspaceId, offer.projectId, offer.id, offer.revision, offer.contentDigest, offer.content.recipientEmail, approval.id, session.userId]);
      } else if (input.operation === "record_sent" || input.operation === "record_unknown") {
        fields(payload, ["reference", "recipientEmail", "revision", "contentDigest", "sentAt"]);
        await requireApproval(tx, offer, session);
        if (payload.recipientEmail !== offer.content.recipientEmail || payload.revision !== offer.revision || payload.contentDigest !== offer.contentDigest) error("DELIVERY_SCOPE_MISMATCH");
        const reference = offerText(payload.reference, "DELIVERY_REFERENCE", 2000);
        const sentAt = input.operation === "record_sent" ? offerDate(payload.sentAt, "SENT_AT") : new Date().toISOString();
        if (Date.parse(sentAt) > Date.now()) error("SENT_TIME_IN_FUTURE", 400);
        const delivery = await tx.queryOne(`update crm_offer_deliveries set status=$4,receipt_reference=$5,attested_by=$6::uuid,attested_at=$7::timestamptz where workspace_id=$1::uuid and offer_id=$2::uuid and revision=$3 and status in ('QUEUED','UNKNOWN') and created_at <= $7::timestamptz returning id`, [session.workspaceId, offer.id, offer.revision, input.operation === "record_sent" ? "MANUALLY_ATTESTED" : "UNKNOWN", reference, session.userId, sentAt]);
        if (!delivery) error("DELIVERY_STATE_CONFLICT");
      } else if (input.operation === "accept" || input.operation === "reject") {
        fields(payload, ["reference", "revision", "contentDigest", "reason"]);
        await assertCloseGrant(tx, session, offer.projectId);
        if (payload.revision !== offer.revision || payload.contentDigest !== offer.contentDigest) error("RESPONSE_SCOPE_MISMATCH");
        if (Date.parse(offer.content.validUntil) <= Date.now()) error("OFFER_EXPIRED");
        const reference = offerText(payload.reference, "RESPONSE_REFERENCE", 2000);
        const reason = input.operation === "reject" ? offerText(payload.reason, "REJECTION_REASON", 2000) : "Offer accepted";
        const receipt = await tx.queryOne(`select id from crm_offer_deliveries where workspace_id=$1::uuid and offer_id=$2::uuid and revision=$3 and content_digest=$4 and status='MANUALLY_ATTESTED'`, [session.workspaceId, offer.id, offer.revision, offer.contentDigest]);
        if (!receipt) error("SENT_OFFER_REQUIRED");
        const deal = await tx.queryOne<{ stage: string }>(`select stage from deals where workspace_id=$1::uuid and id=$2::uuid for update`, [session.workspaceId, offer.dealId]);
        if (!deal) error("DEAL_NOT_FOUND", 404);
        await stopTasks(tx, offer, input.operation);
        await tx.execute(`update crm_offers set status=$3,follow_up_status='STOPPED',follow_up_at=null,follow_up_reason=$4,response_reference=$5,response_actor_id=$6::uuid where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id, status, input.operation, reference, session.userId]);
        const stage = input.operation === "accept" ? "Gewonnen" : "Verloren";
        await tx.execute(`update deals set stage=$3,value_cents=$4,probability=$5,closed_at=now(),lost_at=case when $3='Verloren' then now() else null end,lost_reason_category=$6,lost_reason_detail=$7,version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.dealId, stage, offer.totalNetCents, stage === "Gewonnen" ? 100 : 0, stage === "Gewonnen" ? "won" : "other", reason]);
        if (input.operation === "accept") await tx.execute(`update organizations set lifecycle_stage='Kunde',version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.organizationId]);
        await tx.execute(`insert into deal_stage_history(workspace_id,project_id,deal_id,from_stage,to_stage,changed_by_user_id,reason,reason_category,reason_detail,metadata) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$7,$9::jsonb)`, [session.workspaceId, offer.projectId, offer.dealId, deal.stage, stage, session.userId, reason, stage === "Gewonnen" ? "won" : "other", JSON.stringify({ offerId: offer.id, revision: offer.revision, contentDigest: offer.contentDigest, responseReference: reference, approvalReference: offer.approvalId, auditReference: context.auditReference, correlationId: context.correlationId, contractSent: false })]);
      } else if (input.operation === "schedule_follow_up") {
        fields(payload, ["dueAt"]);
        if (offer.followUpStatus === "SCHEDULED") error("FOLLOW_UP_ALREADY_SCHEDULED");
        const dueAt = offerDate(payload.dueAt, "FOLLOW_UP_AT");
        if (Date.parse(dueAt) <= Date.now()) error("FOLLOW_UP_MUST_BE_FUTURE", 400);
        await tx.execute(`insert into tasks(workspace_id,project_id,contact_id,lead_id,owner_user_id,title,due_at,priority,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::timestamptz,'Normal','open',$8::jsonb)`, [session.workspaceId, offer.projectId, offer.contactId, offer.leadId, session.userId, `Angebot nachfassen: ${offer.content.subject}`, dueAt, JSON.stringify({ offerId: offer.id, revision: offer.revision, deliveryMode: "manual_task_only" })]);
        await tx.execute(`update crm_offers set follow_up_status='SCHEDULED',follow_up_at=$3::timestamptz,follow_up_reason=null where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id, dueAt]);
      } else {
        fields(payload, ["reason"]);
        if (offer.followUpStatus !== "SCHEDULED") error("NO_SCHEDULED_FOLLOW_UP");
        const reason = offerText(payload.reason, "FOLLOW_UP_REASON", 2000);
        await stopTasks(tx, offer, reason);
        await tx.execute(`update crm_offers set follow_up_status=$3,follow_up_at=null,follow_up_reason=$4 where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, offer.id, input.operation === "complete_follow_up" ? "COMPLETED" : "STOPPED", reason]);
      }
      const updated = await tx.queryOne(`update crm_offers set status=$3,version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and version=$4 returning id`, [session.workspaceId, offer.id, status, expectedVersion]);
      if (!updated) error("VERSION_CONFLICT");
      return { id: offer.id, ...(await readView(tx, session, offer.dealId)) };
    }, options);
  } catch (cause) {
    if (cause instanceof OfferValidationError) throw new CrmCommandError(cause.code, cause.code, cause.code.includes("AUTHENTICATION") ? 401 : 409);
    throw cause;
  }
}

/** Called by legacy handlers before writes; canonical commands write through this repository. */
export async function assertLegacyOfferDealWrite(input: { session: AppSession; dealId?: string; targetStage?: unknown }, options: TenantTransactionOptions = {}) {
  return withCrmRead(input.session, async (tx, session) => {
    if (input.dealId) {
      const managed = await tx.queryOne(`select id from crm_offers where workspace_id=$1::uuid and deal_id=$2::uuid`, [session.workspaceId, input.dealId]);
      if (managed) error("USE_CANONICAL_OFFER_WORKFLOW");
    }
    const workspace = await tx.queryOne<{ model: string }>(`select operating_model as model from workspaces where id=$1::uuid`, [session.workspaceId]);
    if (workspace?.model === "novalure_internal" && typeof input.targetStage === "string" && /angebot|offer|gewonnen|aktiv|vertrag|abschluss/i.test(input.targetStage)) error("CANONICAL_OFFER_REQUIRED");
  }, options);
}
export async function assertLegacyOfferMilestone(input: { session: AppSession; dealId?: string | null; milestone?: unknown }, options: TenantTransactionOptions = {}) {
  if (typeof input.milestone === "string" && ["offer_sent", "contract_sent", "contract_signed"].includes(input.milestone)) error("CANONICAL_DELIVERY_EVIDENCE_REQUIRED");
  if (input.dealId) await assertLegacyOfferDealWrite({ session: input.session, dealId: input.dealId }, options);
}

function offerCommandInput(input: OfferCommand) {
  return { operation: `offer.${input.operation}`, resourceId: input.operation === "create" ? assertCrmUuid(input.dealId, "dealId") : assertCrmUuid(input.offerId, "offerId"), projectId: assertCrmUuid(input.projectId, "projectId"), expectedVersion: assertExpectedVersion(input.expectedVersion), idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, payload: input.payload, capability: "pipeline:write" as const };
}
export async function reconcileOfferCommand(session: AppSession, input: OfferCommand, options: TenantTransactionOptions = {}) {
  return reconcileCrmCommand(session, offerCommandInput(input), options);
}
