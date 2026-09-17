import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID,sign} from "node:crypto";
import {test} from "node:test";
import {approvalBinding,approvalEvidencePayload,approvalSteps,verifyApprovalEvidence,validateApprovalTrust,type ApprovalEvidence,type ApprovalScope,type ApprovalTrust} from "../src/lib/approval-reference";
import {createSyntheticApprovalHarness} from "../src/lib/db/approval-reference-repositories";
import {crmPayloadDigest} from "../src/lib/crm-command";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {seedSalesBrowser} from "./lib/sales-browser-fixture.mjs";
import type {AppSession} from "../src/lib/auth/session";
import type {TenantPool} from "../src/lib/db/tenant-client";
import {getRolePermissions} from "../src/lib/auth/permissions";
import {getProductRoleCapabilities} from "../src/lib/product-model";
const metadata=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
const limits={maxValidityMs:300000,maxAuthenticationAgeMs:120000,maxStepGapMs:60000};
function signers(actorId:string){const whatsapp=generateKeyPairSync("ed25519"),web=generateKeyPairSync("ed25519");return {whatsapp,web,trust:[{channel:"evelyn_whatsapp",keyId:"synthetic-local-wa",publicKey:whatsapp.publicKey,actorId},{channel:"evelyn_web",keyId:"synthetic-local-web",publicKey:web.publicKey,actorId}] as readonly ApprovalTrust[]}}
function evidence(keys:ReturnType<typeof signers>,scope:ApprovalScope,id:string,challengeId:string,previous:ApprovalEvidence|null=null,decision:ApprovalEvidence["decision"]="APPROVE"):ApprovalEvidence{
 const binding=approvalBinding(scope),issuedAt=new Date().toISOString();const proof:Omit<ApprovalEvidence,"signature">={environment:"simulation",synthetic:true,approvalId:id,scopeDigest:binding.scopeDigest,actionDigest:binding.actionDigest,actorId:keys.trust[0].actorId,channel:previous?"evelyn_web":"evelyn_whatsapp",keyId:previous?keys.trust[1].keyId:keys.trust[0].keyId,decision,nonce:randomUUID(),challengeId,issuedAt,authenticatedAt:issuedAt,previousEvidenceDigest:previous?crmPayloadDigest(previous):null};return {...proof,signature:sign(null,Buffer.from(approvalEvidencePayload(proof)),previous?keys.web.privateKey:keys.whatsapp.privateKey).toString("base64url")}
}
test("G08 threshold and independent cryptographic channel evidence bind every scope field",()=>{
 assert.equal(approvalSteps("contract.send",499999),1);assert.equal(approvalSteps("contract.send",500000),2);assert.equal(approvalSteps("contract.send",2037000),2);assert.equal(approvalSteps("offer.send",2037000),1);assert.equal(approvalSteps("payment.execute",1),2);
 const keys=signers(randomUUID()),scope:ApprovalScope={workspaceId:randomUUID(),projectId:randomUUID(),resourceId:randomUUID(),resourceVersion:1,actionVersion:1,action:"contract.send",contentDigest:"a".repeat(64),recipient:"synthetic@example.invalid",totalNetCents:2037000,currency:"EUR",taxBasis:"NET",expiresAt:new Date(Date.now()+60000).toISOString()},id=randomUUID(),challengeId=randomUUID(),first=evidence(keys,scope,id,challengeId);
 const verify=(proof:ApprovalEvidence,changes:Partial<ApprovalScope>={})=>verifyApprovalEvidence({scope:{...scope,...changes},approvalId:id,challengeId,evidence:proof,previous:null,trust:keys.trust,now:Date.now(),...limits});
 assert.equal(verify(first).decision,"APPROVE");
 for(const change of [{action:"offer.send" as const},{actionVersion:2},{resourceVersion:2},{workspaceId:randomUUID()},{projectId:randomUUID()},{resourceId:randomUUID()},{contentDigest:"b".repeat(64)},{recipient:"other@example.invalid"},{totalNetCents:100}])assert.throws(()=>verify(first,change));
 assert.throws(()=>verify({...first,signature:"A".repeat(86)}),{code:"UNTRUSTED_APPROVAL_SIGNATURE"});
 assert.throws(()=>verify({...first,channel:"evelyn_web"}),{code:"APPROVAL_EVIDENCE_SCOPE_MISMATCH"});
 assert.throws(()=>validateApprovalTrust([keys.trust[0],{...keys.trust[1],publicKey:keys.whatsapp.publicKey}]),{code:"INDEPENDENT_CHANNEL_TRUST_REQUIRED"});
 assert.throws(()=>verify(first,{expiresAt:new Date(Date.now()-1).toISOString()}));
});

test("G08 persistent local synthetic two-step approval gates a real DB probe, never delivery",{timeout:180000},async t=>{
 const db=await startLocalSalesDb(),old={DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:process.env.NODE_ENV,CRM_SYNTHETIC_APPROVAL_TESTS:process.env.CRM_SYNTHETIC_APPROVAL_TESTS};
 try{
  await applySalesSchema(db);const fixture=await seedSalesBrowser(db),options={pool:db.pool as unknown as TenantPool};
  Object.assign(process.env,{DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,NODE_ENV:"test",CRM_SYNTHETIC_APPROVAL_TESTS:"1"});
  const session={authenticated:true,userId:fixture.userId,workspaceId:fixture.workspaceId,name:"SYNTHETIC approver",email:"synthetic@example.invalid",workspaceName:"SYNTHETIC",role:"owner",productRole:"novalureAdmin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("novalureAdmin"),source:"database"} as AppSession;
  const leadId=randomUUID(),dealId=randomUUID(),offerId=randomUUID();
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type,source,intent) values($1,$2,$3,$4,'Bauträger','Manual','SYNTHETIC accepted fixture')",[leadId,fixture.workspaceId,fixture.projectId,fixture.developerContactId]);
  await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,name,stage) values($1,$2,$3,$4,$5,$6,'SYNTHETIC accepted deal','Gewonnen')",[dealId,fixture.workspaceId,fixture.projectId,fixture.developerContactId,fixture.developerId,leadId]);
  await db.admin.query("insert into crm_offers(id,workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,created_by,status,follow_up_status,response_reference,response_actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,'ACCEPTED','STOPPED','SYNTHETIC seed acceptance',$8)",[offerId,fixture.workspaceId,fixture.projectId,dealId,fixture.developerContactId,leadId,fixture.developerId,fixture.userId]);
  const content={subject:"SYNTHETIC accepted offer",recipientName:"SYNTHETIC recipient",recipientEmail:"synthetic@example.invalid",terms:"SYNTHETIC; no real contract",validUntil:new Date(Date.now()+3600000).toISOString(),currency:"EUR",taxBasis:"NET",items:[{description:"SYNTHETIC setup",quantity:1,unitNetCents:990000},{description:"SYNTHETIC monthly",quantity:3,unitNetCents:349000}]};
  const contentDigest=crmPayloadDigest(content);
  await db.admin.query("insert into crm_offer_revisions(workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by) values($1,$2,$3,1,$4::jsonb,$5,2037000,$6)",[fixture.workspaceId,fixture.projectId,offerId,JSON.stringify(content),contentDigest,fixture.userId]);
  const keys=signers(fixture.userId),harness=createSyntheticApprovalHarness(keys.trust,options,limits);
  const scope=():ApprovalScope=>({workspaceId:fixture.workspaceId,projectId:fixture.projectId,resourceId:offerId,resourceVersion:1,actionVersion:1,action:"contract.send",contentDigest,recipient:content.recipientEmail,totalNetCents:2037000,currency:"EUR",taxBasis:"NET",expiresAt:new Date(Date.now()+240000).toISOString()});
  const approved=async()=>{const binding=scope(),request=await harness.request(session,binding,metadata());const first=evidence(keys,binding,request.data.id,request.data.challengeId);const step=await harness.decide(session,request.data.id,first,metadata());const second=evidence(keys,binding,request.data.id,step.data.challengeId,first);await harness.decide(session,request.data.id,second,metadata());return {id:request.data.id,scope:binding}};
  await t.test("missing and same-channel second steps cannot execute; signed independent steps can",async()=>{
   const binding=scope(),request=await harness.request(session,binding,metadata());await assert.rejects(harness.consume(session,request.data.id,binding,metadata()),{code:"VALID_APPROVAL_REQUIRED"});
   const first=evidence(keys,binding,request.data.id,request.data.challengeId),step=await harness.decide(session,request.data.id,first,metadata());assert.equal(step.data.state,"WAITING_WEB");
   await assert.rejects(harness.consume(session,request.data.id,binding,metadata()),{code:"VALID_APPROVAL_REQUIRED"});
   await assert.rejects(harness.decide(session,request.data.id,{...first,challengeId:step.data.challengeId},metadata()),{code:"APPROVAL_EVIDENCE_SCOPE_MISMATCH"});
   const second=evidence(keys,binding,request.data.id,step.data.challengeId,first);const decided=await harness.decide(session,request.data.id,second,metadata());assert.equal(decided.data.state,"APPROVED");
   const key=metadata(),results=await Promise.all([harness.consume(session,request.data.id,binding,key),harness.consume(session,request.data.id,binding,key)]);
   assert.equal(results[0].data.externalEffect,false);assert.equal(results[1].replayed,true);assert.equal(Number((await db.admin.query("select count(*) from crm_synthetic_approval_effects where approval_id=$1",[request.data.id])).rows[0].count),1);
  });
  await t.test("different execution keys still cannot double-consume one approval",async()=>{
   const item=await approved(),results=await Promise.allSettled([harness.consume(session,item.id,item.scope,metadata()),harness.consume(session,item.id,item.scope,metadata())]);assert.equal(results.filter(value=>value.status==="fulfilled").length,1);
  });
  await t.test("revoke versus consume is serialized and never reports two effects",async()=>{
   const item=await approved(),results=await Promise.allSettled([harness.revoke(session,item.id,metadata()),harness.consume(session,item.id,item.scope,metadata())]);assert.equal(results.filter(value=>value.status==="fulfilled").length,1);assert.ok(Number((await db.admin.query("select count(*) from crm_synthetic_approval_effects where approval_id=$1",[item.id])).rows[0].count)<=1);
  });
  await t.test("rejected proof and changed target cannot produce any synthetic effect",async()=>{
   const binding=scope(),request=await harness.request(session,binding,metadata());await harness.decide(session,request.data.id,evidence(keys,binding,request.data.id,request.data.challengeId,null,"REJECT"),metadata());await assert.rejects(harness.consume(session,request.data.id,binding,metadata()),{code:"VALID_APPROVAL_REQUIRED"});
   const item=await approved();await assert.rejects(harness.consume(session,item.id,{...item.scope,recipient:"other@example.invalid"},metadata()),{code:"APPROVAL_SCOPE_MISMATCH"});
   await db.admin.query("update crm_offers set revision=2,version=version+1 where id=$1",[offerId]);await assert.rejects(harness.consume(session,item.id,item.scope,metadata()),{code:"APPROVAL_RESOURCE_CHANGED"});await db.admin.query("update crm_offers set revision=1,version=version+1 where id=$1",[offerId]);
  });
  await t.test("scope/evidence are immutable and simulation cannot activate on production/Vercel",async()=>{
   const item=await approved();await assert.rejects(db.admin.query("update crm_synthetic_approval_requests set scope_digest=$2,version=version+1 where id=$1",[item.id,"b".repeat(64)]),/APPROVAL_SCOPE_IMMUTABLE/);
   await assert.rejects(db.admin.query("delete from crm_synthetic_approval_evidence where approval_id=$1",[item.id]),/immutable|append|IMMUTABLE/i);
   const previous=process.env.VERCEL;process.env.VERCEL="1";try{assert.throws(()=>createSyntheticApprovalHarness(keys.trust,options,limits),{code:"SYNTHETIC_APPROVAL_HARNESS_DISABLED"});await assert.rejects(harness.consume(session,item.id,item.scope,metadata()),{code:"SYNTHETIC_APPROVAL_HARNESS_DISABLED"})}finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous}
  });
 }finally{for(const [name,value] of Object.entries(old)){if(value===undefined)delete process.env[name];else process.env[name]=value}await db.stop()}
});
