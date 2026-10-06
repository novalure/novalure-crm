import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import test from "node:test";
import type {AppSession} from "../src/lib/auth/session";
import type {TenantPool} from "../src/lib/db/tenant-client";
import {executeOfferCommand,getOfferWorkflow,type OfferCommand} from "../src/lib/db/offer-repositories";
import {createEvelynContractAction,executeEvelynContractCommand,requestEvelynContractApproval,verifyEvelynContractApproval,executeEvelynContractAction,reviseEvelynContractAction,type EvelynContractOptions} from "../src/lib/db/evelyn-contract-repositories";
import {EvelynApprovalError,type EvelynApprovalClient,type EvelynCreateApprovalRequest} from "../src/lib/evelyn-approval-client";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";

test("G08 durable Preview contract boundary against real isolated PostgreSQL",{timeout:180000},async t=>{
 const previous=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:"test"});const db=await startLocalSalesDb();
 try{
  const migrations=await applySalesSchema(db);assert.ok(migrations.includes("086_crm_evelyn_preview_contract.sql"));
  async function fixture(){
   const workspaceId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),organizationId=randomUUID(),contactId=randomUUID(),leadId=randomUUID(),dealId=randomUUID(),authSessionId=randomUUID(),correlationId=randomUUID();
   await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC G08 QA','novalure_internal','novalure_internal',$2::jsonb)",[workspaceId,JSON.stringify({salesApprovalUserId:userId})]);
   const user=await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC approver',$3,'owner','novalureAdmin','active') returning auth_identity_id",[userId,workspaceId,userId+"@example.invalid"]),authIdentityId=user.rows[0].auth_identity_id;
   await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')",[authSessionId,createHash("sha256").update(randomUUID()).digest("hex"),authIdentityId,userId,workspaceId]);
   await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC project','Service')",[projectId,workspaceId]);
   await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC company','Unternehmen')",[organizationId,workspaceId,projectId]);
   await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role,email,consent_label) values($1,$2,$3,$4,$5,'SYNTHETIC Buyer','Kunde','buyer@example.invalid','Opt-in')",[contactId,workspaceId,projectId,organizationId,userId]);
   await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Manual','Käufer','Neu')",[leadId,workspaceId,projectId,contactId,userId]);
   await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC deal','Qualifizieren',2037000)",[dealId,workspaceId,projectId,contactId,organizationId,leadId,userId]);
   await db.admin.query("insert into crm_evelyn_preview_targets(workspace_id,project_id,evelyn_tenant_id) values($1,$2,$1)",[workspaceId,projectId]);
   const session={authenticated:true,userId,workspaceId,workspaceName:"SYNTHETIC G08 QA",email:userId+"@example.invalid",name:"SYNTHETIC owner",role:"owner",permissions:["crm:read","crm:write"],productRole:"novalureAdmin",productPermissions:["pipeline:write","novalure:internal"],source:"database",authIdentityId,authSessionId,sessionCreatedAt:new Date()} as AppSession;
   const pool={pool:db.pool as unknown as TenantPool};
   const offerCommand=async(operation:OfferCommand["operation"],payload:Record<string,unknown>={})=>{const view=await getOfferWorkflow(session,dealId,pool);return executeOfferCommand(session,{operation,projectId,dealId,offerId:view.offer?.id,expectedVersion:view.offer?.version??view.dealVersion,payload,idempotencyKey:randomUUID(),correlationId:randomUUID()},pool)};
   await offerCommand("create",{leadId,content:{subject:"SYNTHETIC standard-value proposal",recipientName:"SYNTHETIC Buyer",recipientEmail:"buyer@example.invalid",terms:"SYNTHETIC scope; no real contract delivery",validUntil:new Date(Date.now()+86400000).toISOString(),currency:"EUR",taxBasis:"NET",items:[{description:"Setup",quantity:1,unitNetCents:990000},{description:"Monthly",quantity:3,unitNetCents:349000}]}});
   let offer=(await getOfferWorkflow(session,dealId,pool)).offer!;
   await offerCommand("approve",{revision:offer.revision,contentDigest:offer.contentDigest,expiresAt:new Date(Date.now()+3600000).toISOString()});await offerCommand("queue_send");
   // PostgreSQL records microseconds; wait for an actual later JS millisecond.
   await db.admin.query("select pg_sleep(0.005)");
   await offerCommand("record_sent",{revision:offer.revision,contentDigest:offer.contentDigest,recipientEmail:offer.content.recipientEmail,reference:"SYNTHETIC manual receipt",sentAt:new Date().toISOString()});
   await offerCommand("accept",{revision:offer.revision,contentDigest:offer.contentDigest,reference:"SYNTHETIC customer accepted"});offer=(await getOfferWorkflow(session,dealId,pool)).offer!;
   const approvals=new Map<string,{reference:string;body:EvelynCreateApprovalRequest}>(),calls={requests:0,verifies:0};let valid=false,onVerify:(()=>Promise<void>)|undefined;
   const client:EvelynApprovalClient={
    async requestApproval(body){calls.requests++;let row=approvals.get(body.requestId);if(!row){row={reference:randomUUID(),body};approvals.set(body.requestId,row)}assert.deepEqual(row.body,body);return {contractVersion:"create-approval-request-v1",environment:"preview",approvalReference:row.reference,actionId:body.action.actionId,actionVersion:body.action.actionVersion,actionHash:body.actionHash,requiredSteps:2,status:"PENDING",auditReference:randomUUID(),correlationId:body.correlationId}},
    async verifyApproval(body){calls.verifies++;await onVerify?.();const row=[...approvals.values()].find(a=>a.reference===body.approvalReference);if(!row)throw new EvelynApprovalError("INVALID");if(row.body.actionHash!==body.actionHash)throw new EvelynApprovalError("ACTION_MISMATCH");if(row.body.action.tenantId!==body.tenantId)throw new EvelynApprovalError("TENANT_MISMATCH");if(!valid)throw new EvelynApprovalError("PENDING");return {contractVersion:"approval-bridge-v1",environment:"preview",status:"VALID",approvalReference:body.approvalReference,correlationId:body.correlationId}}};
   const options:EvelynContractOptions={...pool,testOnly:{target:{workspaceId,projectId,tenantId:workspaceId},client}};
   const metadata=()=>({idempotencyKey:randomUUID(),correlationId});
   const createInput={...metadata(),offerId:offer.id,projectId,expectedOfferVersion:offer.version};
   const create=()=>createEvelynContractAction(session,createInput,options);
   const make=async()=>{const created=await create();return {...metadata(),actionId:created.data.actionId,expectedVersion:1}};
   return {session,workspaceId,projectId,offer,options,metadata,createInput,create,make,calls,approvals,setValid:()=>{valid=true},onVerify:(fn:()=>Promise<void>)=>{onVerify=fn}};
  }
  await t.test("registered synthetic target, identical tenant and approved acceptance source are mandatory",async()=>{
   const f=await fixture();await db.admin.query("update crm_evelyn_preview_targets set enabled=false where workspace_id=$1",[f.workspaceId]);await assert.rejects(f.create(),{code:"EVELYN_QA_TARGET_NOT_REGISTERED"});
   await db.admin.query("update crm_evelyn_preview_targets set enabled=true where workspace_id=$1",[f.workspaceId]);
   await assert.rejects(createEvelynContractAction(f.session,f.createInput,{...f.options,testOnly:{...f.options.testOnly!,target:{workspaceId:f.workspaceId,projectId:f.projectId,tenantId:randomUUID()}}}),{code:"EVELYN_TENANT_MAPPING_FORBIDDEN"});
   await db.admin.query("update crm_offers set status='SENT',version=version+1 where id=$1",[f.offer.id]);await assert.rejects(f.create(),{code:"ACCEPTED_APPROVED_OFFER_REQUIRED"});
  });
  await t.test("one source offer has one action lineage across same-key replay and parallel different keys",async()=>{
   const f=await fixture(),results=await Promise.allSettled([f.create(),createEvelynContractAction(f.session,{...f.createInput,idempotencyKey:randomUUID()},f.options)]);
   assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
   const count=await db.admin.query("select count(*)::int as count from crm_evelyn_contract_actions where offer_id=$1",[f.offer.id]);assert.equal(count.rows[0].count,1);
   const g=await fixture(),first=await g.create(),replay=await g.create();assert.equal(replay.replayed,true);assert.equal(first.data.actionId,replay.data.actionId);
  });
  await t.test("20370 EUR derives from accepted source and duplicated requests persist a single reference",async()=>{
   const f=await fixture(),input=await f.make();const first=await requestEvelynContractApproval(f.session,input,f.options),again=await requestEvelynContractApproval(f.session,input,f.options);
   assert.equal(first.data.requiredSteps,2);assert.equal(again.replayed,true);assert.equal(first.data.approvalReference,again.data.approvalReference);
   const body=[...f.approvals.values()][0].body;assert.equal(body.action.amount,2037000);assert.equal(body.policyEvidence.approvedOffer,true);assert.equal(body.policyEvidence.customerAccepted,true);assert.equal(body.policyEvidence.approvedTemplate,false);assert.notEqual(body.policyReferences.customerAcceptanceId,body.policyReferences.approvedOfferId);
   assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_approvals where action_id=$1",[input.actionId])).rows[0].count,1);
  });
  await t.test("actual dispatcher records the server operation and refuses an ungranted same-tenant actor",async()=>{
   const f=await fixture();await executeEvelynContractCommand(f.session,{operation:"create",...f.createInput},f.options);
   const receipt=await db.admin.query("select operation from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[f.workspaceId,f.createInput.idempotencyKey]);assert.equal(receipt.rows[0].operation,"evelyn.contract.create");
   const otherId=randomUUID();await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC ungranted',$3,'agent','novalureServiceOps','active')",[otherId,f.workspaceId,otherId+"@example.invalid"]);
   const other={...f.session,userId:otherId,authIdentityId:undefined,authSessionId:undefined}, action=await f.create();await assert.rejects(requestEvelynContractApproval(other,{...f.metadata(),actionId:action.data.actionId,expectedVersion:1},f.options),{code:"EVELYN_ACTION_NOT_ACCESSIBLE"});
  });
  await t.test("pending cannot execute; fresh repeated verification and concurrent retry commit exactly once",async()=>{
   const f=await fixture(),input=await f.make();await requestEvelynContractApproval(f.session,input,f.options);const exec={...input,...f.metadata()};
   await assert.rejects(executeEvelynContractAction(f.session,exec,f.options),{code:"PENDING"});assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_executions where action_id=$1",[input.actionId])).rows[0].count,0);
   f.setValid();const verify={...input,...f.metadata()};await verifyEvelynContractApproval(f.session,verify,f.options);await verifyEvelynContractApproval(f.session,verify,f.options);
   const results=await Promise.all([executeEvelynContractAction(f.session,exec,f.options),executeEvelynContractAction(f.session,exec,f.options)]);assert.equal(results.filter(r=>r.replayed).length,1);
   assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_executions where action_id=$1",[input.actionId])).rows[0].count,1);
   const calls=f.calls.verifies;await executeEvelynContractAction(f.session,exec,f.options);assert.equal(f.calls.verifies,calls,"committed retry returns authorized receipt without a second effect");
   await assert.rejects(executeEvelynContractAction(f.session,{...exec,...f.metadata()},f.options),{code:"EVELYN_ALREADY_EXECUTED"});
  });
  await t.test("same idempotency identity with different approval payload is rejected before remote verify",async()=>{
   const f=await fixture(),input=await f.make();await requestEvelynContractApproval(f.session,input,f.options);f.setValid();const verify={...input,...f.metadata()};await verifyEvelynContractApproval(f.session,verify,f.options);const calls=f.calls.verifies;
   await assert.rejects(verifyEvelynContractApproval(f.session,{...verify,approvalReference:randomUUID()},f.options),{code:"IDEMPOTENCY_CONFLICT"});assert.equal(f.calls.verifies,calls);
  });
  await t.test("changing amount creates immutable revision and old approval cannot verify or execute",async()=>{
   const f=await fixture(),input=await f.make(),requested=await requestEvelynContractApproval(f.session,input,f.options);f.setValid();
   const revision={...input,...f.metadata(),contractNetCents:2037001};const changed=await reviseEvelynContractAction(f.session,revision,f.options);assert.equal(changed.data.actionVersion,2);
   const replay=await reviseEvelynContractAction(f.session,revision,f.options);assert.equal(replay.replayed,true);assert.equal(replay.data.actionVersion,2);
   await assert.rejects(reviseEvelynContractAction(f.session,{...revision,contractNetCents:2037002},f.options),{code:"IDEMPOTENCY_CONFLICT"});
   const next={...input,...f.metadata(),expectedVersion:2,approvalReference:requested.data.approvalReference};await assert.rejects(verifyEvelynContractApproval(f.session,next,f.options),{code:"ACTION_MISMATCH"});await assert.rejects(executeEvelynContractAction(f.session,{...next,...f.metadata()},f.options),{code:"APPROVAL_REFERENCE_MISMATCH"});
   await assert.rejects(db.admin.query("update crm_evelyn_contract_revisions set action_hash=$2 where action_id=$1",[input.actionId,"a".repeat(64)]),/immutable|IMMUTABLE/i);
  });
  await t.test("revision during the external verify call blocks the final transactional effect",async()=>{
   const f=await fixture(),input=await f.make();await requestEvelynContractApproval(f.session,input,f.options);f.setValid();f.onVerify(async()=>{await reviseEvelynContractAction(f.session,{...input,...f.metadata(),contractNetCents:2037001},f.options)});
   await assert.rejects(executeEvelynContractAction(f.session,{...input,...f.metadata()},f.options),{code:"VERSION_MISMATCH"});assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_executions where action_id=$1",[input.actionId])).rows[0].count,0);
  });
  await t.test("source offer mutation during external verify blocks final effect and preserves source binding",async()=>{
   const f=await fixture(),input=await f.make();await requestEvelynContractApproval(f.session,input,f.options);f.setValid();f.onVerify(async()=>{await db.admin.query("update crm_offers set version=version+1 where id=$1",[f.offer.id])});
   await assert.rejects(executeEvelynContractAction(f.session,{...input,...f.metadata()},f.options),{code:"EVELYN_SOURCE_CHANGED"});assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_executions where action_id=$1",[input.actionId])).rows[0].count,0);
  });
  await t.test("audit failure rolls back execution; immutable audit records and default RLS deny tampering",async()=>{
   const f=await fixture(),input=await f.make();await requestEvelynContractApproval(f.session,input,f.options);f.setValid();
   await db.admin.query("create function qa_g08_fail_event() returns trigger language plpgsql as $$ begin if new.stage='EXECUTE' then raise exception 'INJECTED_G08_AUDIT_FAILURE'; end if; return new; end $$");await db.admin.query("create trigger qa_g08_fail before insert on crm_evelyn_contract_events for each row execute function qa_g08_fail_event()");
   const exec={...input,...f.metadata()};await assert.rejects(executeEvelynContractAction(f.session,exec,f.options),/INJECTED_G08_AUDIT_FAILURE/);assert.equal((await db.admin.query("select count(*)::int as count from crm_evelyn_contract_executions where action_id=$1",[input.actionId])).rows[0].count,0);
   await db.admin.query("drop trigger qa_g08_fail on crm_evelyn_contract_events");await executeEvelynContractAction(f.session,exec,f.options);
   await assert.rejects(db.admin.query("delete from crm_evelyn_contract_events where action_id=$1",[input.actionId]),/immutable|IMMUTABLE/i);
   assert.equal((await db.pool.query("select count(*)::int as count from crm_evelyn_contract_actions")).rows[0].count,0);
  });
  await t.test("revoked allowlist and production test overrides fail closed",async()=>{
   const f=await fixture(),input=await f.make();await db.admin.query("update crm_evelyn_preview_targets set enabled=false where workspace_id=$1",[f.workspaceId]);await assert.rejects(requestEvelynContractApproval(f.session,input,f.options),{code:"EVELYN_QA_TARGET_NOT_REGISTERED"});
   const old=process.env.VERCEL;process.env.VERCEL="1";try{await assert.rejects(f.create(),{code:"EVELYN_TEST_OVERRIDE_DISABLED"})}finally{if(old===undefined)delete process.env.VERCEL;else process.env.VERCEL=old}
  });
 }finally{await db.stop();if(previous===undefined)delete (process.env as Record<string,string|undefined>).NODE_ENV;else Object.assign(process.env,{NODE_ENV:previous})}
});
