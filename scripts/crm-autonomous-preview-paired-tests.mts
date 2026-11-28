import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {autonomousPreviewFixture} from './crm-autonomous-preview-tests';
import {handleAutonomousCrmModules} from '../src/lib/crm-autonomous-modules';
import {handleAutonomousCrmNonexecution} from '../src/lib/crm-autonomous-nonexecution';
import {autonomousPreviewAudience} from '../src/lib/crm-autonomous-preview-auth';
import {crmPayloadDigest} from '../src/lib/crm-command';
import type {TenantPool} from '../src/lib/db/tenant-client';

const modulePath=process.env.CRM_PAIRED_EVELYN_MODULE,revision=process.env.CRM_PAIRED_EVELYN_REVISION;
if(!modulePath||!revision||!/^[a-f0-9]{40}$/.test(revision))throw new Error('EXACT_PREVIEW_COUNTERPART_REQUIRED');
const absolute=resolve(modulePath),checkout=resolve(process.env.CRM_PAIRED_EVELYN_CHECKOUT??resolve(dirname(absolute),'../../..'));
const git=(...args:string[])=>execFileSync('git',['-C',checkout,...args],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
assert.equal(git('rev-parse','HEAD'),revision);assert.equal(git('status','--porcelain','--untracked-files=no'),'');
const paths=[absolute,join(dirname(absolute),'crm-nonexecution-client.js'),join(dirname(absolute),'crm-machine-client.js')];
const pins=[process.env.CRM_PAIRED_EVELYN_MODULE_SHA256,process.env.CRM_PAIRED_NONEXECUTION_MODULE_SHA256,process.env.CRM_PAIRED_MACHINE_MODULE_SHA256];
for(let i=0;i<paths.length;i++)assert.equal(createHash('sha256').update(await readFile(paths[i]!)).digest('hex'),pins[i],'every actual compiled counterpart byte must match the handed-off pin');
const actual=await import(pathToFileURL(absolute).href),closeClient=await import(pathToFileURL(paths[1]!).href);

test('actual Preview sender custom audience and original platform header reach real V2/Recovery handlers and PG',async()=>{
 const f=autonomousPreviewFixture(),r=await f.fixture(false),handoff=await f.provision(r),authTokens=new Set<string>(),platformTokens=new Set<string>();
 let versions=0,posts=0,dropAck=false;
 const getToken=async(options?:{audience?:string;jti?:string})=>{const jwt=await f.token({aud:options?.audience??'https://vercel.com/novalure',jti:options?.jti??randomUUID()});(options?.audience?authTokens:platformTokens).add(jwt);if(options?.audience)assert.equal(options.audience,autonomousPreviewAudience);return jwt;};
 const fetcher:typeof fetch=async(input,init)=>{
  const req=new Request(String(input),init);assert.equal(new URL(req.url).origin,f.receiver.origin);assert.equal(platformTokens.has(req.headers.get('x-vercel-trusted-oidc-idp-token')??''),true);
  if(req.method==='GET'){assert.equal(new URL(req.url).pathname,'/api/version');versions++;return Response.json({deploymentId:f.receiver.deploymentId,gitSha:f.receiver.revision});}
  assert.equal(authTokens.has(req.headers.get('authorization')!.slice(7)),true);assert.notEqual(req.headers.get('authorization')!.slice(7),req.headers.get('x-vercel-trusted-oidc-idp-token'));posts++;
  const b=await req.clone().json();const response=req.headers.has('x-evelyn-recovery')?await handleAutonomousCrmNonexecution(req,{pool:f.runtime as unknown as TenantPool,machineAuth:f.auth()}):await handleAutonomousCrmModules(req,{pool:f.runtime as unknown as TenantPool,machineAuth:f.auth()});
  if(dropAck&&b?.operation==='Update'&&response.status===200){dropAck=false;await response.arrayBuffer();throw new Error('SYNTHETIC lost committed acknowledgement');}return response;
 };
 const make=(h:typeof handoff)=>{const assignment={...h.grant,signingKeyReference:'synthetic.preview.paired-key'};return actual.createCrmOperationsClient(assignment,{profile:'preview',receiver:h.receiver,resolveGrant:async()=>assignment,resolveSigningKey:async()=>f.key.privateKey,getToken,fetch:fetcher});};
 const readOnly=make(handoff);
 for(const operation of ['DescribeAssignment','Read']){const result=await readOnly.execute(f.body(operation));assert.equal(result.outcome,'CONFIRMED',JSON.stringify(result));}
 assert.equal((await f.db.admin.query('select count(*) from crm_command_receipts where resource_id=$1',[r.sourceId])).rows[0].count,'0');
 // Local component exercise only. This is not a hosted mutation/intent approval.
 const write=await f.fixture(true),wh=await f.provision(write),client=make(wh),body=f.body('Update',{title:'SYNTHETIC: paired Preview change'},1);
 dropAck=true;const lost=await client.execute(body);assert.equal(lost.outcome,'UNKNOWN',JSON.stringify(lost));const restored=await client.resume(lost.pending);assert.equal(restored.outcome,'CONFIRMED',JSON.stringify(restored));assert.equal(restored.receipt.replayed,true);
 const authority=randomUUID();await f.db.admin.query("insert into crm_autonomous_recovery_authorities(id,workload_id,control_project_id,grant_ids,recovery_public_key,authority_reference,expires_at) values($1,$2,$3,array[$4::uuid],$5,'SYNTHETIC paired Preview recovery',clock_timestamp()+interval '5 minutes')",[authority,write.workloadId,f.control,write.grantId,f.recovery.publicKey.export({format:'der',type:'spki'}).toString('base64url')]);
 const binding=(b:typeof body)=>({grantId:write.grantId,workspaceId:f.ids.workspace,sourceId:write.sourceId,taskId:write.taskId,departmentId:write.departmentId,agentId:write.agentId,entity:'Task',crmProjectId:write.projectId,controlProjectId:f.control,missionId:randomUUID(),attemptId:randomUUID(),effectId:randomUUID(),registryVersion:'1',targetDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64),requestDigest:crmPayloadDigest(b)});
 const closer=(b:typeof body)=>closeClient.createCrmNonexecutionClient(binding(b),{profile:'preview',receiver:wh.receiver,recoveryAuthorityId:authority,resolveRecoverySigningKey:async()=>f.recovery.privateKey,getToken,fetch:fetcher});
 const applied=await closer(body).close(body);assert.equal(applied.outcome,'CONFIRMED',JSON.stringify(applied));assert.equal(applied.receipt.outcome,'APPLIED');assert.equal(applied.receipt.auditReference,restored.receipt.auditReference);
 const pending=f.body('Update',{title:'SYNTHETIC: fenced Preview update'},2),fence=closer(pending),first=await fence.close(pending),repeat=await fence.close(pending);
 assert.equal(first.outcome,'CONFIRMED',JSON.stringify(first));assert.equal(first.receipt.outcome,'NO_EFFECT');assert.equal(repeat.receipt.closureReference,first.receipt.closureReference);assert.equal(repeat.receipt.replayed,true);
 assert.notEqual((await f.call(write,pending)).status,200);assert.equal(Number((await f.db.admin.query('select version from tasks where id=$1',[write.sourceId])).rows[0].version),2);
 assert.equal(git('rev-parse','HEAD'),revision);assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 console.log('PREVIEW_PAIRED_EVIDENCE '+JSON.stringify({evelynRevision:revision,compiledPins:pins,profile:'preview',versions,posts,actualPgAndHandlers:true,auth:'REAL_SYNTHETIC_RSA_AND_ED25519',audience:autonomousPreviewAudience,originalPlatformHeader:true,readOnlyNativeEligibility:'NO_NATIVE_RUN',localMutationRecovery:'COMPONENT_ONLY_NO_HOSTED_INTENT_OR_CLOSE_APPROVAL',versionGet:'SYNTHETIC_STUB_ONLY',providerActions:0}));
});
