import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {SignJWT,jwtVerify,type JWTVerifyOptions} from "jose";
import {autonomousPairedFixture} from "./crm-autonomous-modules-tests";
import {handleAutonomousCrmModules} from "../src/lib/crm-autonomous-modules";
import {CRM_MACHINE_AUDIENCE,CRM_MACHINE_ISSUER,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_SUBJECT,type CrmMachineAuthOptions} from "../src/lib/crm-machine-auth";
import type {TenantPool} from "../src/lib/db/tenant-client";

// Intentionally separate from the normal single-repository CI: a real compiled
// counterpart AND its immutable source revision are mandatory explicit inputs.
const counterpart=process.env.CRM_PAIRED_EVELYN_MODULE,expectedRevision=process.env.CRM_PAIRED_EVELYN_REVISION;
if(!counterpart||!expectedRevision||!/^[a-f0-9]{40}$/.test(expectedRevision))throw new Error("EXACT_COMPILED_EVELYN_COUNTERPART_REQUIRED");
const counterpartPath=path.resolve(counterpart),checkout=path.resolve(path.dirname(counterpartPath),"../../..");
assert.equal(execFileSync("git",["-C",checkout,"rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).trim(),expectedRevision);
const actualClient=await import(pathToFileURL(counterpartPath).href);
assert.equal(typeof actualClient.createCrmOperationsClient,"function");
const compiledSha256=createHash("sha256").update(await readFile(counterpartPath)).digest("hex");
const rsa=generateKeyPairSync("rsa",{modulusLength:2048});
const machineAuth:CrmMachineAuthOptions={env:{CRM_MACHINE_AUTH_ENABLED:"1",VERCEL_ENV:"production",NODE_ENV:"production"},verifier:async(token,options)=>jwtVerify(token,rsa.publicKey,options as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>};
const token=async(options?:{jti?:string})=>{const now=Math.floor(Date.now()/1000);return new SignJWT({iss:CRM_MACHINE_ISSUER,aud:CRM_MACHINE_AUDIENCE,sub:CRM_MACHINE_SUBJECT,project_id:CRM_MACHINE_PROJECT_ID,owner_id:CRM_MACHINE_OWNER_ID,environment:"production",iat:now,nbf:now,exp:now+60,jti:options?.jti??randomUUID()}).setProtectedHeader({alg:"RS256",typ:"JWT",kid:"synthetic-paired-rsa"}).sign(rsa.privateKey);};

test("paired immutable Evelyn client and real CRM handler recover a lost response through actual RSA/Ed25519 and PostgreSQL",async()=>{
 const f=autonomousPairedFixture(),parentKey=generateKeyPairSync("ed25519"),childKey=generateKeyPairSync("ed25519");
 const parent=f.registration("Task",f.ids.task,{agentId:"synthetic.sales.paired.parent",scopes:["crm.tasks.read","crm.tasks.write"],publicKey:parentKey.publicKey.export({format:"der",type:"spki"}).toString("base64url"),module:{contractVersion:"crm-autonomous-access-v2",readFields:["title","status"],writeFields:["title"],relatedResources:{},lifecycleMode:"EXISTING",delegationKind:"DEPARTMENT",parentGrantId:null}});await f.provision(parent);
 const child=f.registration("Task",f.ids.task,{agentId:"synthetic.sales.paired.child",scopes:["crm.tasks.read","crm.tasks.write"],publicKey:childKey.publicKey.export({format:"der",type:"spki"}).toString("base64url"),module:{contractVersion:"crm-autonomous-access-v2",readFields:["title"],writeFields:["title"],relatedResources:{},lifecycleMode:"EXISTING",delegationKind:"SUBAGENT",parentGrantId:parent.grantId}});await f.provision(child);
 const assignment=(r:typeof parent,key:typeof parentKey)=>({grantId:r.grantId,workspaceId:f.ids.workspace,projectId:f.ids.project,sourceId:f.ids.task,taskId:f.ids.mission,departmentId:r.departmentId,agentId:r.agentId,entity:r.entity,signingKeyReference:`paired.${r.agentId}`,publicKeyDigest:createHash("sha256").update(key.publicKey.export({format:"der",type:"spki"})).digest("hex"),delegationKind:r.module!.delegationKind,parentGrantId:r.module!.parentGrantId,operations:["DescribeAssignment","Read","Update"],readFields:r.module!.readFields,writeFields:r.module!.writeFields,expiresAt:Math.floor(Date.now()/1000)+60});
 let dropNext=false,serverCalls=0,realRsaVerifications=0;
 const fetcher:typeof fetch=async(input,init)=>{
  serverCalls++;const request=new Request(String(input),init),raw=await request.clone().json();
  const response=await handleAutonomousCrmModules(request,{pool:f.db.pool as unknown as TenantPool,machineAuth:{...machineAuth,verifier:async(t,o)=>{realRsaVerifications++;return machineAuth.verifier!(t,o);}}});
  if(dropNext&&raw.operation==="Update"&&response.status===200){dropNext=false;await response.arrayBuffer();throw new Error("SYNTHETIC committed response lost");}return response;
 };
 const parentAssignment=assignment(parent,parentKey),childAssignment=assignment(child,childKey);
 const parentClient=actualClient.createCrmOperationsClient(parentAssignment,{resolveGrant:async()=>parentAssignment,resolveSigningKey:async()=>parentKey.privateKey,getToken:token,fetch:fetcher});
 const childClient=actualClient.createCrmOperationsClient(childAssignment,{resolveGrant:async()=>childAssignment,resolveSigningKey:async()=>childKey.privateKey,getToken:token,fetch:fetcher});
 const described=await childClient.execute(f.body("DescribeAssignment"));assert.equal(described.outcome,"CONFIRMED",JSON.stringify(described));assert.equal(described.receipt.data.parentGrantId,parent.grantId);assert.equal(described.receipt.data.delegationKind,"SUBAGENT");
 const read=await childClient.execute(f.body());assert.equal(read.outcome,"CONFIRMED",JSON.stringify(read));
 const command=f.body("Update",{title:"SYNTHETIC exact cross-repository write"},read.receipt.data.version);dropNext=true;
 const lost=await childClient.execute(command);assert.equal(lost.outcome,"UNKNOWN");const recovered=await childClient.resume(lost.pending);assert.equal(recovered.outcome,"CONFIRMED",JSON.stringify(recovered));assert.equal(recovered.receipt.replayed,true);assert.equal(recovered.receipt.data.title,command.patch.title);assert.equal(recovered.receipt.data.version,command.expectedVersion!+1);
 assert.equal((await f.db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[f.ids.workspace,command.idempotencyKey])).rows[0].count,"1");

 // The production parent client really observes its live assignment; then a
 // child request passes initial authentication but waits before its effect.
 const parentDescription=await parentClient.execute(f.body("DescribeAssignment"));assert.equal(parentDescription.outcome,"CONFIRMED",JSON.stringify(parentDescription));
 const race=f.body("Update",{title:"SYNTHETIC parent revoked before effect"},recovered.receipt.data.version),lock=await f.db.admin.connect();
 try{
  await lock.query("begin");await lock.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`crm-command:${f.ids.workspace}:${race.idempotencyKey}`]);
  const pending=childClient.execute(race);let waiter=false;
  for(let i=0;i<100;i++){if((await f.db.admin.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%' and pid<>pg_backend_pid()")).rowCount){waiter=true;break;}await delay(10);}
  assert.equal(waiter,true);await f.db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1",[parent.grantId]);await lock.query("commit");
  const denied=await pending;assert.equal(denied.outcome,"DENIED",JSON.stringify(denied));assert.equal(denied.code,"ACCESS_DENIED");
  assert.equal((await f.db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1",[race.idempotencyKey])).rows[0].count,"0");
  assert.equal((await f.db.admin.query("select title from tasks where id=$1",[f.ids.task])).rows[0].title,command.patch.title);
 }finally{await lock.query("rollback");lock.release();}
 assert.ok(serverCalls>=6);assert.equal(realRsaVerifications,serverCalls);
 process.stdout.write(`PAIRED_EVIDENCE ${JSON.stringify({evelynRevision:expectedRevision,compiledClientSha256:compiledSha256,serverCalls,realRsaVerifications,credentials:"SYNTHETIC_LOCAL_ONLY",parentRace:"DENIED_ZERO_EFFECT",lostResponse:"ORIGINAL_RECEIPT_RECOVERED"})}\n`);
});
