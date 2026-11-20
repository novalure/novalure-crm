import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { withCrmRead } from "../src/lib/crm-command";
import { runWebsiteSalesIrelandCommand,websiteSalesIrelandContract } from "../src/lib/db/website-sales-ireland-repositories";
import { executeWebsiteSalesStudioCommand as execute, readWebsiteSalesStudio as read, reconcileWebsiteSalesStudioCommand as reconcile, websiteStudioPublicPreview as preview,websiteStudioQaRender } from "../src/lib/db/website-sales-studio-repositories";
import { canonicalWebsiteStudioQaPayload,websiteSalesStudioContract,type WebsiteSalesStudioCommand,type WebsiteStudioQaPayload } from "../src/lib/website-sales-studio-types";
import { websiteStudioRenderedResponse } from "../src/lib/website-sales-studio-http";
import { startLocalSalesDb,applySalesSchema } from "./lib/local-sales-db.mjs";

test("Studio persists real immutable artifacts and independently signed, revocable source-bound previews",{timeout:240000},async t=>{
 const db=await startLocalSalesDb(),originalKeys=process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS;
 try{
  await applySalesSchema(db,{maxMigrationNumber:90});for(const file of ["202_website_sales_ireland.sql","204_website_sales_studio.sql"]){await db.admin.query("begin");await db.admin.query(await readFile(`migrations/${file}`,"utf8"));await db.admin.query("commit");}
  const ids={workspace:randomUUID(),otherWorkspace:randomUUID(),actor:randomUUID(),qa:randomUUID(),otherActor:randomUUID(),project:randomUUID(),otherProject:randomUUID(),company:randomUUID(),otherCompany:randomUUID(),contact:randomUUID(),pipeline:randomUUID()};
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Synthetic Studio','novalure_internal','novalure_internal'),($2,'Other tenant','novalure_internal','novalure_internal')",[ids.workspace,ids.otherWorkspace]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Builder','builder@example.invalid','agent','novalure_sales'),($3,$2,'Independent QA','qa@example.invalid','agent','novalure_sales'),($4,$5,'Other tenant','other@example.invalid','agent','novalure_sales')",[ids.actor,ids.workspace,ids.qa,ids.otherActor,ids.otherWorkspace]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Studio test','Website','WEB_DESIGN'),($3,$4,'Other project','Website','WEB_DESIGN')",[ids.project,ids.workspace,ids.otherProject,ids.otherWorkspace]);
  await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'studio-test','Existing pipeline','novalure_internal',true)",[ids.pipeline,ids.workspace,ids.project]);
  await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Qualification',1,'work')",[ids.pipeline,ids.workspace,ids.project]);
  await db.admin.query("update projects set default_pipeline_id=$2 where id=$1",[ids.project,ids.pipeline]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'Synthetic company','Unternehmen','WEB_DESIGN'),($4,$5,$6,'Foreign company','Unternehmen','WEB_DESIGN')",[ids.company,ids.workspace,ids.project,ids.otherCompany,ids.otherWorkspace,ids.otherProject]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email) values($1,$2,$3,$4,'Existing recipient','Ansprechpartner','recipient@example.invalid')",[ids.contact,ids.workspace,ids.project,ids.company]);
  const session:AppSession={authenticated:true,source:"database",workspaceId:ids.workspace,userId:ids.actor,workspaceName:"Synthetic",name:"Builder",email:"builder@example.invalid",role:"agent",productRole:"novalure_sales",permissions:getRolePermissions("agent"),productPermissions:getProductRoleCapabilities("novalure_sales")},qaSession={...session,userId:ids.qa},other={...session,workspaceId:ids.otherWorkspace,userId:ids.otherActor};
  const options={pool:db.pool as unknown as TenantPool};
  const base={contractVersion:websiteSalesIrelandContract,projectId:ids.project,companyId:ids.company} as const;
  const registered=await runWebsiteSalesIrelandCommand(session,{...base,operation:"register_location",idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{countryCode:"IE",address:"1 Synthetic Street, Dublin, Ireland",sourceUrl:"https://example.invalid/location",sourceReference:"Synthetic local test only"}},options),locationId=registered.data.location.id;
  const identity={workspaceId:ids.workspace,projectId:ids.project,companyId:ids.company,locationId},end=new Date(Date.now()+86400000).toISOString();
  const prospect={identity,country:"IRELAND",identityStatus:"VERIFIED",domain:null,path:"NO_WEBSITE",ownWebsiteSearch:"NONE_FOUND",obstacle:null,platformUrl:null,bookingRoute:"UNKNOWN",need:"EVIDENCED",evidence:["IDENTITY","OWN_WEBSITE_SEARCH","BUSINESS_NEED"].map(kind=>({evidenceId:kind.toLowerCase(),identity,kind,sourceUrl:"https://example.invalid/"+kind,observedAt:new Date(Date.now()-60000).toISOString(),validUntil:end,validityCondition:"Synthetic evidence remains current",finding:"Synthetic scoped source fact",confidence:.9}))};
  const observed=await runWebsiteSalesIrelandCommand(session,{...base,operation:"observe",locationId,locationVersion:1,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{prospect}},options);
  const qualified=await runWebsiteSalesIrelandCommand(session,{...base,operation:"qualify",locationId,expectedVersion:observed.data.workflow!.version,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{contactId:ids.contact,opportunitySummary:"Synthetic opportunity",nextAction:"Internal review",expectedEvidenceDigest:observed.data.workflow!.evidenceDigest}},options),workflow=qualified.data.workflow!;
  const scope={projectId:ids.project,companyId:ids.company,locationId},investmentPlan={estimatedCostMinor:0,availableBudgetMinor:0,expectedNetPriceMinor:250000,estimatedDeliveryCostMinor:50000,minimumMarginBasisPoints:3000,requiredCapacityMinutes:60,availableCapacityMinutes:600,rightsVerified:true,budgetReference:null},claim={text:"Synthetic scoped source fact",evidenceIds:["business_need"]},scopeContent={included:["Proposed website structure"],excluded:["Customer assets, contact, payments and publication"]};
  const cmd=(operation:WebsiteSalesStudioCommand["operation"],payload:Record<string,unknown>):WebsiteSalesStudioCommand=>({contractVersion:websiteSalesStudioContract,operation,...scope,workflowId:workflow.id,expectedWorkflowVersion:workflow.version,expectedEvidenceDigest:workflow.evidenceDigest,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload});
  const diagnosisCommand=cmd("create_diagnosis",{version:1,previousArtifactDigest:null,recommendations:[claim],scope:scopeContent,investmentPlan});
  let diagnosisId="",diagnosisDigest="",conceptId="",conceptDigest="",demoId="",grantId="",cookie="";
  await t.test("stage completion comes from persisted current parents and canonical CRM labels",async()=>{
   const d=await execute(session,diagnosisCommand,options);diagnosisId=d.data.artifactId!;diagnosisDigest=d.data.artifactDigest!;
   assert.equal((await execute(session,diagnosisCommand,options)).replayed,true);assert.equal((await reconcile(session,diagnosisCommand,options)).status,"COMMITTED");
   await assert.rejects(execute(session,{...diagnosisCommand,payload:{...diagnosisCommand.payload,scope:{included:["Changed"],excluded:["Other"]}}},options),{code:"IDEMPOTENCY_CONFLICT"});
   await assert.rejects(execute(session,cmd("create_diagnosis",{...diagnosisCommand.payload,investmentPlan:{...investmentPlan,completedStage:"CONCEPT"}}),options),{code:"INVALID_STUDIO_PAYLOAD"});
   await assert.rejects(execute(session,cmd("build_demo",{version:1,previousArtifactDigest:null,conceptDigest:diagnosisDigest,investmentPlan}),options),{code:"STUDIO_CURRENT_PARENT_REQUIRED"});
   const c=await execute(session,cmd("create_concept",{version:1,previousArtifactDigest:null,diagnosisDigest,objective:"A clearer website structure",hero:claim,sections:[{title:"Proposed service information",body:claim}],visualDirection:"STUDIO_BLUE",scope:scopeContent,investmentPlan}),options);conceptId=c.data.artifactId!;conceptDigest=c.data.artifactDigest!;
   await assert.rejects(execute(session,cmd("build_demo",{version:1,previousArtifactDigest:null,conceptDigest,investmentPlan}),options),{code:"STUDIO_CONCEPT_ACCEPTANCE_REQUIRED"});
   await execute(session,cmd("accept_concept",{artifactId:conceptId}),options);
   demoId=(await execute(session,cmd("build_demo",{version:1,previousArtifactDigest:null,conceptDigest,investmentPlan}),options)).data.artifactId!;
   const state=await read(session,scope,options),drow=state.artifacts.find(a=>a.id===diagnosisId)!;assert.equal(drow.artifact.kind,"DIAGNOSIS");if(drow.artifact.kind==="DIAGNOSIS"){assert.equal(drow.artifact.content.companyName,"Synthetic company");assert.equal(drow.artifact.content.locationLabel,"1 Synthetic Street, Dublin, Ireland");}assert.equal(state.canContact,false);
  });
  const keys=generateKeyPairSync("ed25519"),revision="a".repeat(40);process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS=JSON.stringify([{issuer:"local-independent-tests",keyId:"test-only",workspaceId:ids.workspace,projectId:ids.project,qaActorId:ids.qa,sourceRevision:revision,publicKeySpkiPem:keys.publicKey.export({type:"spki",format:"pem"})}]);
  await t.test("unsigned, mismatched and builder self-attested QA cannot open a preview",async()=>{
   await assert.rejects(execute(session,cmd("submit_qa",{artifactId:demoId,certificate:{approved:true}}),options),{code:"SIGNED_RENDERED_QA_REQUIRED"});
   await assert.rejects(execute(session,cmd("create_preview",{artifactId:demoId,contactId:ids.contact,expiresAt:new Date(Date.now()+600000).toISOString()}),options),{code:"SIGNED_RENDERED_QA_REQUIRED"});
   await assert.rejects(websiteStudioQaRender(session,scope,demoId,options),{code:"QA_ISSUER_REQUIRED"});
   const demo=await websiteStudioQaRender(qaSession,scope,demoId,options);assert.equal(demo.kind,"DEMO");assert.equal((await websiteStudioRenderedResponse(demo,"studio.css").text()).includes("@media"),true);
   const payload:WebsiteStudioQaPayload={contractVersion:"website-sales-rendered-qa-v1",issuer:"local-independent-tests",keyId:"test-only",certificateId:randomUUID(),...identity,workflowId:workflow.id,artifactDigest:demo.artifactDigest,htmlDigest:demo.content.htmlDigest,assetManifestDigest:demo.content.assetManifestDigest,evidenceDigest:demo.evidenceDigest,qaActorId:ids.qa,sourceRevision:revision,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),checks:{desktop:true,tablet:true,mobile:true,reducedMotion:true,keyboard:true,noConsoleErrors:true,noSideEffects:true}};
   const certificate={payload,signature:sign(null,Buffer.from(canonicalWebsiteStudioQaPayload(payload)),keys.privateKey).toString("base64url")};
   await assert.rejects(execute(session,cmd("submit_qa",{artifactId:demoId,certificate:{...certificate,payload:{...payload,htmlDigest:"b".repeat(64)}}}),options),{code:"RENDERED_QA_SCOPE_DENIED"});
   await assert.rejects(execute(session,cmd("submit_qa",{artifactId:demoId,certificate:{...certificate,signature:"A".repeat(86)}}),options),{code:"RENDERED_QA_SIGNATURE_DENIED"});
   await execute(session,cmd("submit_qa",{artifactId:demoId,certificate}),options);
  });
  await t.test("one-time invitation and grant cookie protect exact HTML and every asset; no secret receipt",async()=>{
   const request=cmd("create_preview",{artifactId:demoId,contactId:ids.contact,expiresAt:new Date(Date.now()+600000).toISOString()}),created=await execute(session,request,options);assert.ok(created.invitation);grantId=String(created.data.grantId);
   assert.equal((await execute(session,request,options)).invitation,undefined);
   const persisted=(await db.admin.query("select response::text from crm_command_receipts where idempotency_key=$1",[request.idempotencyKey])).rows[0].response;assert.equal(persisted.includes(created.invitation.token),false);
   assert.equal(await preview(grantId,"0".repeat(64),false,options),null);assert.equal(await preview(grantId,created.invitation.token,false,options),null);
   const opened=await preview(grantId,created.invitation.token,true,options);assert.ok(opened?.cookie);cookie=opened.cookie;
   assert.equal(await preview(grantId,created.invitation.token,true,options),null);
   const served=await preview(grantId,cookie,false,options);assert.ok(served);assert.equal(await websiteStudioRenderedResponse(served.artifact).text(),served.artifact.content.html);assert.equal(websiteStudioRenderedResponse(served.artifact,"evil.js").status,404);
  });
  await t.test("FORCE RLS, two tenants, append-only rows and no generic anonymous access",async()=>{
   await assert.rejects(read(other,scope,options),{code:"PROJECT_FORBIDDEN"});
   const count=await withCrmRead(other,tx=>tx.queryOne<{n:number}>("select count(*)::int as n from crm_website_studio_artifacts"),options);assert.equal(count?.n,0);
   await assert.rejects(withCrmRead(session,tx=>tx.execute("update crm_website_studio_artifacts set version=99 where id=$1",[demoId]),options),{code:"42501"});
   const forced=await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where relname like 'crm_website_studio_%' and relkind='r'");assert.equal(forced.rows.length,4);assert.ok(forced.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
  });
  await t.test("direct runtime SQL cannot drift acceptance, QA or preview artifact scope",async()=>{
   const sameTenantProject=randomUUID();await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Wrong same-tenant scope','Website','WEB_DESIGN')",[sameTenantProject,ids.workspace]);
   await assert.rejects(withCrmRead(session,tx=>tx.execute("insert into crm_website_studio_acceptances(workspace_id,project_id,company_id,location_id,workflow_id,artifact_id,accepted_by) values($1,$2,$3,$4,$5,$6,$7)",[ids.workspace,sameTenantProject,ids.company,locationId,workflow.id,diagnosisId,ids.actor]),options),{code:"23503"});
   await assert.rejects(withCrmRead(session,tx=>tx.execute("insert into crm_website_studio_qa(id,workspace_id,project_id,company_id,location_id,workflow_id,artifact_id,qa_actor_id,certificate,checked_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,now(),now()+interval '1 hour')",[randomUUID(),ids.workspace,sameTenantProject,ids.company,locationId,workflow.id,demoId,ids.qa]),options),{code:"23503"});
   const savedQa=(await db.admin.query("select id from crm_website_studio_qa where artifact_id=$1",[demoId])).rows[0].id;
   await assert.rejects(withCrmRead(session,tx=>tx.execute("insert into crm_website_studio_preview_grants(workspace_id,project_id,company_id,location_id,workflow_id,artifact_id,qa_id,contact_id,invitation_hash,expires_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes',$10)",[ids.workspace,ids.project,ids.company,locationId,workflow.id,diagnosisId,savedQa,ids.contact,"0".repeat(64),ids.actor]),options),{code:"23503"});
  });
  await t.test("revocation and committed contact opt-out close HTML and assets immediately",async()=>{
   await db.admin.query("update contacts set consent_label='Abgemeldet' where id=$1",[ids.contact]);assert.equal(await preview(grantId,cookie,false,options),null);
   await db.admin.query("update contacts set consent_label='Unbekannt' where id=$1",[ids.contact]);assert.ok(await preview(grantId,cookie,false,options));
   await execute(session,cmd("revoke_preview",{grantId,expectedVersion:1}),options);assert.equal(await preview(grantId,cookie,false,options),null);
  });
  await t.test("expired capability and removed issuer key deny the same stored HTML and assets",async()=>{
   const created=await execute(session,cmd("create_preview",{artifactId:demoId,contactId:ids.contact,expiresAt:new Date(Date.now()+600000).toISOString()}),options),id=String(created.data.grantId),opened=await preview(id,created.invitation!.token,true,options);assert.ok(opened);
   const configured=process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS;delete process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS;assert.equal(await preview(id,opened.cookie!,false,options),null);process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS=configured;
   await db.admin.query("update crm_website_studio_preview_grants set created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' where id=$1",[id]);assert.equal(await preview(id,opened.cookie!,false,options),null);
  });
  await t.test("new diagnosis invalidates prior demo preview despite identical current evidence",async()=>{
   const created=await execute(session,cmd("create_preview",{artifactId:demoId,contactId:ids.contact,expiresAt:new Date(Date.now()+600000).toISOString()}),options),opened=await preview(String(created.data.grantId),created.invitation!.token,true,options);assert.ok(opened);
   await execute(session,cmd("create_diagnosis",{...diagnosisCommand.payload,version:2,previousArtifactDigest:diagnosisDigest}),options);
   assert.equal(await preview(String(created.data.grantId),opened.cookie!,false,options),null);
   await assert.rejects(execute(session,cmd("create_preview",{artifactId:demoId,contactId:ids.contact,expiresAt:new Date(Date.now()+600000).toISOString()}),options),{code:"STUDIO_PARENT_CHANGED"});
  });
 }finally{if(originalKeys===undefined)delete process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS;else process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS=originalKeys;await db.stop();}
});
