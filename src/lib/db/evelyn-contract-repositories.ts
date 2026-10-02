import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertExpectedVersion, assertMoneyCents, assertProjectGrant, CrmCommandError, executeCrmCommand, reconcileCrmCommand, withCrmRead, type CrmCommandInput, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { createEvelynApprovalClient, evelynActionHash, EvelynApprovalError, type EvelynApprovalClient, type EvelynApprovalAction, type EvelynCreateApprovalRequest } from "@/lib/evelyn-approval-client";
import { offerTotal, parseOfferContent, type OfferContent } from "@/lib/offer-workflow";
import { getOfferApprovalReference } from "./approval-reference-repositories";

type Metadata = { idempotencyKey: string; correlationId: string };
export type EvelynContractActionInput = Metadata & { actionId: string; expectedVersion: number; approvalReference?: string };
export type EvelynContractCommand =
  | (Metadata & { operation: "create"; projectId: string; offerId: string; expectedOfferVersion: number })
  | (EvelynContractActionInput & { operation: "revise"; projectId: string; contractNetCents: number })
  | (EvelynContractActionInput & { operation: "request" | "verify" | "execute"; projectId: string });
type Target = { workspaceId: string; projectId: string; tenantId: string };
/** Test injection is rejected outside a real loopback test transaction. Routes pass no overrides. */
export type EvelynContractOptions = TenantTransactionOptions & { testOnly?: { target: Target; client: EvelynApprovalClient } };
type Source = { id: string; projectId: string; version: number; revision: number; contactId: string; approvalId: string; contentDigest: string; content: OfferContent; total: string; acceptanceId: string };
type Snapshot = { id: string; projectId: string; offerId: string; offerVersion: number; offerRevision: number; sourceApprovalId: string; sourceContentDigest: string; correlationId: string; version: number; currentVersion: number; action: EvelynApprovalAction; actionHash: string; approvalReference: string | null; approvalContractVersion: string };
function failure(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
const safeCode = (error: unknown) => error instanceof EvelynApprovalError || error instanceof CrmCommandError ? error.code : "EVELYN_UNAVAILABLE";
function derivedId(key: string, suffix: string) {
  const bytes = createHash("sha256").update(`crm-evelyn:${key}:${suffix}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function target(options: EvelynContractOptions): Target {
  if (options.testOnly) {
    if (process.env.NODE_ENV !== "test" || !options.pool || process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined || process.env.VERCEL_URL !== undefined) failure("EVELYN_TEST_OVERRIDE_DISABLED", 403);
  } else if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "preview") failure("EVELYN_PREVIEW_ONLY", 403);
  const configured = options.testOnly?.target ?? { workspaceId: process.env.CRM_EVELYN_QA_WORKSPACE_ID!, projectId: process.env.CRM_EVELYN_QA_PROJECT_ID!, tenantId: process.env.CRM_EVELYN_QA_TENANT_ID! };
  for (const value of Object.values(configured)) assertCrmUuid(value);
  if (configured.tenantId !== configured.workspaceId) failure("EVELYN_TENANT_MAPPING_FORBIDDEN", 403);
  return configured;
}
async function guard(tx: TenantTransaction, session: AppSession, projectId: string, options: EvelynContractOptions) {
  const configured = target(options);
  if (session.workspaceId !== configured.workspaceId || projectId !== configured.projectId) failure("EVELYN_QA_SCOPE_DENIED", 403);
  await assertProjectGrant(tx, session, projectId, true);
  if (options.testOnly && !(await tx.queryOne<{local: boolean}>("select inet_server_addr() in ('127.0.0.1'::inet,'::1'::inet) as local"))?.local) failure("LOCAL_TEST_DATABASE_REQUIRED", 403);
  const allowed = await tx.queryOne<{allowed:boolean}>("select crm_lock_evelyn_preview_target($1::uuid,$2::uuid,$3::uuid) as allowed", [session.workspaceId, projectId, configured.tenantId]);
  if (!allowed?.allowed) failure("EVELYN_QA_TARGET_NOT_REGISTERED", 403);
  return configured;
}
async function source(tx: TenantTransaction, session: AppSession, offerId: string, projectId: string): Promise<Source> {
  const row = await tx.queryOne<Source>(`select o.id,o.project_id as "projectId",o.version,o.revision,o.contact_id as "contactId",o.approval_id as "approvalId",r.content_digest as "contentDigest",r.content,r.total_net_cents as total,
    (select h.id from deal_stage_history h where h.workspace_id=o.workspace_id and h.deal_id=o.deal_id and h.to_stage='Gewonnen' and h.metadata->>'offerId'=o.id::text and h.metadata->>'contentDigest'=r.content_digest and h.metadata->>'approvalReference'=o.approval_id::text order by h.changed_at desc limit 1) as "acceptanceId"
    from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
    where o.workspace_id=$1::uuid and o.project_id=$2::uuid and o.id=$3::uuid and o.status='ACCEPTED' and o.response_reference is not null and o.response_actor_id is not null for share of o`, [session.workspaceId, projectId, assertCrmUuid(offerId)]);
  if (!row?.approvalId || !row.acceptanceId) failure("ACCEPTED_APPROVED_OFFER_REQUIRED");
  const approved = await getOfferApprovalReference(session, row.approvalId);
  if (approved.status !== "APPROVED" || approved.scope.contentDigest !== row.contentDigest || approved.scope.resourceId !== row.id || approved.scope.resourceVersion !== Number(row.revision)) failure("CURRENT_OFFER_APPROVAL_REQUIRED");
  row.content = parseOfferContent(row.content);
  if (!row.content.subject.startsWith("SYNTHETIC") || !row.content.terms.startsWith("SYNTHETIC") || !row.content.recipientEmail.endsWith(".invalid") || offerTotal(row.content) !== Number(row.total)) failure("SYNTHETIC_OFFER_REQUIRED", 403);
  row.version = Number(row.version); row.revision = Number(row.revision);
  return row;
}
async function read(tx: TenantTransaction, session: AppSession, input: EvelynContractActionInput, options: EvelynContractOptions, receiptOnly = false): Promise<Snapshot> {
  const row = await tx.queryOne<Snapshot>(`select a.id,a.project_id as "projectId",a.offer_id as "offerId",a.offer_version as "offerVersion",a.offer_revision as "offerRevision",a.source_approval_id as "sourceApprovalId",a.source_content_digest as "sourceContentDigest",a.correlation_id as "correlationId",a.version as "currentVersion",r.version,r.action,r.action_hash as "actionHash",r.approval_contract_version as "approvalContractVersion",p.approval_reference as "approvalReference"
    from crm_evelyn_contract_actions a join crm_evelyn_contract_revisions r on r.workspace_id=a.workspace_id and r.action_id=a.id and r.version=$3
    left join crm_evelyn_contract_approvals p on p.workspace_id=a.workspace_id and p.action_id=a.id and p.version=r.version
    where a.workspace_id=$1::uuid and a.id=$2::uuid for update of a`, [session.workspaceId, assertCrmUuid(input.actionId), assertExpectedVersion(input.expectedVersion)]);
  if (!row) failure("EVELYN_ACTION_NOT_ACCESSIBLE", 404);
  if (row.approvalContractVersion !== "v1") failure("EVELYN_CONTRACT_VERSION_MISMATCH");
  await guard(tx, session, row.projectId, options);
  if (!receiptOnly && row.currentVersion !== input.expectedVersion) failure("VERSION_MISMATCH");
  if (row.correlationId !== input.correlationId) failure("CORRELATION_MISMATCH");
  const current = await source(tx, session, row.offerId, row.projectId);
  if (current.version !== row.offerVersion || current.revision !== row.offerRevision || current.approvalId !== row.sourceApprovalId || current.contentDigest !== row.sourceContentDigest) failure("EVELYN_SOURCE_CHANGED");
  if (evelynActionHash(row.action) !== row.actionHash || row.action.actionVersion !== row.version || row.action.tenantId !== session.workspaceId) failure("ACTION_MISMATCH");
  return row;
}
function command(operation: string, input: EvelynContractActionInput, snapshot: Snapshot): CrmCommandInput {
  return { operation, resourceId: input.actionId, projectId: snapshot.projectId, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, payload: { actionId: input.actionId, actionVersion: input.expectedVersion, actionHash: snapshot.actionHash, approvalReference: input.approvalReference ?? null }, capability: "pipeline:write" };
}
async function record(tx: TenantTransaction, session: AppSession, snapshot: Snapshot, stage: "REQUEST" | "VERIFY" | "EXECUTE", code: string, reference: string | null) {
  await tx.execute("insert into crm_evelyn_contract_events(workspace_id,project_id,action_id,version,recorded_by,correlation_id,stage,result_code,approval_reference) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9::uuid)", [session.workspaceId, snapshot.projectId, snapshot.id, snapshot.version, session.userId, snapshot.correlationId, stage, /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "EVELYN_UNAVAILABLE", reference]);
}
async function denial(session: AppSession, snapshot: Snapshot, stage: "REQUEST" | "VERIFY" | "EXECUTE", error: unknown, options: EvelynContractOptions) {
  await withCrmRead(session, async (tx, fresh) => { await guard(tx, fresh, snapshot.projectId, options); await record(tx, fresh, snapshot, stage, safeCode(error), snapshot.approvalReference); }, options);
}
function client(options: EvelynContractOptions) { const configured = target(options); return options.testOnly?.client ?? createEvelynApprovalClient(configured.tenantId); }
export async function createEvelynContractAction(session: AppSession, input: Metadata & { offerId: string; projectId: string; expectedOfferVersion: number }, options: EvelynContractOptions = {}) {
  target(options);
  return executeCrmCommand(session, {operation:"evelyn.contract.create",resourceId:input.offerId,projectId:input.projectId,expectedVersion:assertExpectedVersion(input.expectedOfferVersion),idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,payload:{offerId:input.offerId,projectId:input.projectId,expectedOfferVersion:input.expectedOfferVersion},capability:"pipeline:write"}, async (tx, context) => {
    const configured = await guard(tx, context.session, input.projectId, options), origin = await source(tx, context.session, input.offerId, input.projectId);
    if (origin.version !== input.expectedOfferVersion) failure("VERSION_MISMATCH");
    const id = derivedId(origin.id,"contract");
    const action: EvelynApprovalAction = {actionId:id,workflowId:id,tenantId:configured.tenantId,requestingActorId:session.userId,actionType:"contract.send",resourceType:"Contract",resourceId:id,actionVersion:1,resourceVersion:1,amount:Number(origin.total),currency:"EUR",net:true,payload:{recipient:{id:origin.contactId,email:origin.content.recipientEmail},contract:{id,version:1,content:`SYNTHETIC contract derived from accepted offer ${origin.id}; revision ${origin.revision}; digest ${origin.contentDigest}`},scope:{projectId:input.projectId,description:"SYNTHETIC Preview contract approval verification; no delivery"},price:{netCents:Number(origin.total),currency:"EUR"}}};
    const actionHash = evelynActionHash(action);
    await tx.execute("insert into crm_evelyn_contract_actions(id,workspace_id,project_id,offer_id,created_by,correlation_id,offer_version,offer_revision,source_approval_id,source_content_digest) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::uuid,$10)",[id,session.workspaceId,input.projectId,origin.id,session.userId,input.correlationId,origin.version,origin.revision,origin.approvalId,origin.contentDigest]);
    await tx.execute("insert into crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version,created_by,action,action_hash) values($1::uuid,$2::uuid,$3::uuid,1,$4::uuid,$5::jsonb,$6)",[session.workspaceId,input.projectId,id,session.userId,JSON.stringify(action),actionHash]);
    return {actionId:id,actionVersion:1,actionHash,amount:action.amount,correlationId:input.correlationId,synthetic:true,externalEffect:false};
  },options);
}
export async function reviseEvelynContractAction(session: AppSession, input: EvelynContractActionInput & { contractNetCents: number }, options: EvelynContractOptions = {}) {
  const snapshot = await withCrmRead(session,(tx,fresh)=>read(tx,fresh,input,options,true),options);
  const amount = assertMoneyCents(input.contractNetCents); if (amount < 1) failure("INVALID_MONEY",400);
  const revisionCommand={...command("evelyn.contract.revise",input,snapshot),payload:{actionId:input.actionId,expectedVersion:input.expectedVersion,contractNetCents:amount,approvalReference:input.approvalReference??null}};
  const prior=await reconcileCrmCommand<{actionId:string;actionVersion:number;actionHash:string;amount:number;correlationId:string;approvalReference:null}>(session,revisionCommand,options);
  if(prior.status==="COMMITTED")return {data:prior.data,replayed:true,auditReference:prior.auditReference,commandId:prior.commandId};
  return executeCrmCommand(session,revisionCommand,async(tx,ctx)=>{
    const current = await read(tx,ctx.session,input,options);
    if(await tx.queryOne("select id from crm_evelyn_contract_executions where workspace_id=$1::uuid and action_id=$2::uuid",[session.workspaceId,current.id]))failure("EVELYN_ALREADY_EXECUTED");
    const version=current.version+1, action:EvelynApprovalAction={...current.action,actionVersion:version,resourceVersion:version,amount,payload:{...current.action.payload,contract:{...current.action.payload.contract,version},price:{netCents:amount,currency:"EUR"}}},actionHash=evelynActionHash(action);
    await tx.execute("insert into crm_evelyn_contract_revisions(workspace_id,project_id,action_id,version,created_by,action,action_hash) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::jsonb,$7)",[session.workspaceId,current.projectId,current.id,version,session.userId,JSON.stringify(action),actionHash]);
    await tx.execute("update crm_evelyn_contract_actions set version=$3 where workspace_id=$1::uuid and id=$2::uuid",[session.workspaceId,current.id,version]);
    return {actionId:current.id,actionVersion:version,actionHash,amount,correlationId:input.correlationId,approvalReference:null};
  },options);
}
async function prepare(session: AppSession,input:EvelynContractActionInput,operation:string,options:EvelynContractOptions) {
  const snapshot=await withCrmRead(session,(tx,fresh)=>read(tx,fresh,input,options),options);
  await executeCrmCommand(session,{...command(operation+".intent",input,snapshot),idempotencyKey:derivedId(input.idempotencyKey,"intent")},async(tx,ctx)=>{const current=await read(tx,ctx.session,input,options);return {actionId:current.id,actionVersion:current.version,actionHash:current.actionHash};},options);
  return snapshot;
}
export async function requestEvelynContractApproval(session: AppSession,input:EvelynContractActionInput,options:EvelynContractOptions={}) {
  const snapshot=await prepare(session,input,"evelyn.contract.request",options);
  const origin=await withCrmRead(session,(tx,fresh)=>source(tx,fresh,snapshot.offerId,snapshot.projectId),options);
  const request:EvelynCreateApprovalRequest={contractVersion:"create-approval-request-v1",requestId:input.idempotencyKey,correlationId:snapshot.correlationId,action:snapshot.action,actionHash:snapshot.actionHash,policyEvidence:{financialTotalKnown:true,standardContract:false,approvedOffer:true,customerAccepted:true,approvedTemplate:false},policyReferences:{approvedOfferId:origin.id,customerAcceptanceId:origin.acceptanceId,approvedTemplateId:null}};
  try {
    const remote=await client(options).requestApproval(request);
    return await executeCrmCommand(session,command("evelyn.contract.request",input,snapshot),async(tx,ctx)=>{
      const current=await read(tx,ctx.session,input,options);
      if(current.actionHash!==snapshot.actionHash)failure("ACTION_MISMATCH");
      if(current.approvalReference&&current.approvalReference!==remote.approvalReference)failure("APPROVAL_REFERENCE_CONFLICT");
      if(!current.approvalReference)await tx.execute("insert into crm_evelyn_contract_approvals(workspace_id,project_id,action_id,version,recorded_by,approval_reference,correlation_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid)",[session.workspaceId,current.projectId,current.id,current.version,session.userId,remote.approvalReference,current.correlationId]);
      await record(tx,ctx.session,current,"REQUEST",remote.status,remote.approvalReference);
      return remote;
    },options);
  } catch(error) {await denial(session,snapshot,"REQUEST",error,options);throw error;}
}
async function verified(session:AppSession,input:EvelynContractActionInput,stage:"VERIFY"|"EXECUTE",options:EvelynContractOptions) {
  const snapshot=await prepare(session,input,"evelyn.contract."+stage.toLowerCase(),options);
  const approvalReference=input.approvalReference??snapshot.approvalReference;
  if(!approvalReference)failure("APPROVAL_REFERENCE_REQUIRED");
  assertCrmUuid(approvalReference);
  if(stage==="EXECUTE"&&approvalReference!==snapshot.approvalReference)failure("APPROVAL_REFERENCE_MISMATCH");
  try {
    const result=await client(options).verifyApproval({approvalReference,tenantId:session.workspaceId,actionId:snapshot.id,actionType:"contract.send",resourceId:snapshot.action.resourceId,actionVersion:snapshot.version,actionHash:snapshot.actionHash,correlationId:snapshot.correlationId});
    return {snapshot,result,approvalReference};
  } catch(error) {await denial(session,snapshot,stage,error,options);throw error;}
}
export async function verifyEvelynContractApproval(session:AppSession,input:EvelynContractActionInput,options:EvelynContractOptions={}) {
  const {snapshot,result,approvalReference}=await verified(session,input,"VERIFY",options);
  // Verification remains fresh even for repeated calls; no cached local APPROVED state.
  return withCrmRead(session,async(tx,fresh)=>{const current=await read(tx,fresh,input,options);if(current.actionHash!==snapshot.actionHash)failure("ACTION_MISMATCH");await record(tx,fresh,current,"VERIFY","VALID",approvalReference);return {...result,actionVersion:current.version,actionHash:current.actionHash};},options);
}
export async function executeEvelynContractAction(session:AppSession,input:EvelynContractActionInput,options:EvelynContractOptions={}) {
  const preflight=await withCrmRead(session,(tx,fresh)=>read(tx,fresh,input,options),options), execution=command("evelyn.contract.execute",input,preflight);
  const prior=await reconcileCrmCommand(session,execution,options);
  if(prior.status==="COMMITTED")return {data:prior.data,replayed:true,auditReference:prior.auditReference,commandId:prior.commandId};
  const {snapshot,approvalReference}=await verified(session,input,"EXECUTE",options);
  return executeCrmCommand(session,execution,async(tx,ctx)=>{
    const current=await read(tx,ctx.session,input,options);
    if(current.actionHash!==snapshot.actionHash||current.approvalReference!==approvalReference)failure("ACTION_MISMATCH");
    if(await tx.queryOne("select id from crm_evelyn_contract_executions where workspace_id=$1::uuid and action_id=$2::uuid",[session.workspaceId,current.id]))failure("EVELYN_ALREADY_EXECUTED");
    const effect=await tx.queryOne<{id:string}>("insert into crm_evelyn_contract_executions(workspace_id,project_id,action_id,version,executed_by,approval_reference,correlation_id) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid) returning id",[session.workspaceId,current.projectId,current.id,current.version,session.userId,approvalReference,current.correlationId]);
    await record(tx,ctx.session,current,"EXECUTE","VALID",approvalReference);
    return {id:effect!.id,actionId:current.id,actionVersion:current.version,approvalReference,correlationId:current.correlationId,effect:"SYNTHETIC_CONTRACT_SEND",externalEffect:false,contractDelivered:false};
  },options);
}
export async function getEvelynContractAction(session: AppSession, actionId: string, options: EvelynContractOptions = {}) {
  return withCrmRead(session, async(tx,fresh)=>{
    const row=await tx.queryOne<{version:number;correlationId:string}>("select version,correlation_id as \"correlationId\" from crm_evelyn_contract_actions where workspace_id=$1::uuid and id=$2::uuid",[fresh.workspaceId,assertCrmUuid(actionId)]);
    if(!row)failure("EVELYN_ACTION_NOT_ACCESSIBLE",404);
    const snapshot=await read(tx,fresh,{actionId,expectedVersion:row.version,correlationId:row.correlationId,idempotencyKey:randomUUID()},options);
    return {actionId:snapshot.id,projectId:snapshot.projectId,offerId:snapshot.offerId,actionVersion:snapshot.version,actionHash:snapshot.actionHash,amount:snapshot.action.amount,correlationId:snapshot.correlationId,approvalReference:snapshot.approvalReference,synthetic:true,externalEffect:false};
  },options);
}
export async function executeEvelynContractCommand(session:AppSession,input:EvelynContractCommand,options:EvelynContractOptions={}) {
  const configured=target(options);
  if(input.projectId!==configured.projectId)failure("EVELYN_QA_SCOPE_DENIED",403);
  switch(input.operation){
    case "create":return createEvelynContractAction(session,input,options);
    case "revise":return reviseEvelynContractAction(session,input,options);
    case "request":return requestEvelynContractApproval(session,input,options);
    case "verify":return verifyEvelynContractApproval(session,input,options);
    case "execute":return executeEvelynContractAction(session,input,options);
  }
}
