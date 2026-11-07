import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after,before,test} from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import {executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '../src/lib/crm-command';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import type {CustomerRequestPurpose} from '../src/lib/lead-customer-request';
let db:Awaited<ReturnType<typeof startLocalSalesDb>>,options:TenantTransactionOptions,root:string;
let repository:typeof import('../src/lib/lead-customer-request-repository'),qualification:typeof import('../src/lib/lead-qualification-repository'),automation:typeof import('../src/lib/automation/repository');
const workspaceId=randomUUID(),projectId=randomUUID(),actorId=randomUUID(),limitedId=randomUUID(),contactId=randomUUID(),leadId=randomUUID();
const session:AppSession={authenticated:true,source:'headers',workspaceId,userId:actorId,workspaceName:'Synthetic requests',name:'Synthetic Owner',email:'requests@qa.invalid',role:'owner',productRole:'customer_owner',permissions:['crm:read','crm:write'],productPermissions:['pipeline:write']};
const limited:AppSession={...session,userId:limitedId,role:'agent',productRole:'project_sales_member'};
const keys=['NOVALURE_MEDIA_ROOT','NOVALURE_AUTH_ENCRYPTION_KEY','NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN','BLOB_PRIVATE_READ_WRITE_TOKEN','NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN','BLOB_READ_WRITE_TOKEN','VERCEL','VERCEL_ENV','VERCEL_URL'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const command=<T>(fn:(tx:TenantTransaction,fresh:AppSession)=>Promise<T>)=>executeCrmCommand(session,{operation:'lead_request.qa',projectId,capability:'pipeline:write',payload:{},idempotencyKey:randomUUID(),correlationId:randomUUID()},(tx,context)=>fn(tx,context.session),options);
const query=async(sql:string,params:unknown[])=>{const rows=await db.pool.query(sql,params);return rows.rows[0]??null;};
const pdf=()=>new File(['%PDF-1.7\nSYNTHETIC REQUEST EVIDENCE\n%%EOF'],'synthetic.pdf',{type:'application/pdf'});
const details={name:'Self-reported Buyer',email:'new-buyer@qa.invalid',phone:'+430000001',privacyRead:true};
const profile={countryCode:'IE',location:'Dublin',propertyType:'Wohnung',budgetFromCents:10000000,budgetToCents:30000000,areaSqm:40,rooms:2,privacyRead:true};
async function create(purpose:CustomerRequestPurpose){const result=await command((tx,fresh)=>repository.createCustomerRequest(tx,fresh,{leadId,purpose,language:'en'}));const state=await repository.getCustomerRequestState(session,leadId,options),request=state.requests.find(r=>r.id===result.data.id)!;return{...request,token:request.path!.split('/').pop()!};}
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'lead-request-'));for(const key of keys)delete process.env[key];process.env.NOVALURE_MEDIA_ROOT=root;process.env.NOVALURE_AUTH_ENCRYPTION_KEY='synthetic-only-encryption-key-for-local-request-tests';
 repository=await import('../src/lib/lead-customer-request-repository');qualification=await import('../src/lib/lead-qualification-repository');automation=await import('../src/lib/automation/repository');
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const file of['154_automation_graph.sql','159_lead_qualification.sql','162_lead_customer_requests.sql'])await db.admin.query(await readFile(`migrations/${file}`,'utf8'));
 options={pool:db.pool as unknown as NonNullable<TenantTransactionOptions['pool']>};
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic requests','managed_by_novalure')",[workspaceId]);
 await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'Owner','requests@qa.invalid','owner','customer_owner','active'),($2,$3,'Limited','requests-limited@qa.invalid','agent','project_sales_member','active')",[actorId,limitedId,workspaceId]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic project','Makler')",[projectId,workspaceId]);
 await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[workspaceId,projectId,limitedId]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role) values($1,$2,$3,'Original private name','old-buyer@qa.invalid','Käufer')",[contactId,workspaceId,projectId]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,intent) values($1,$2,$3,$4,$5,'Käufer','Original confidential inquiry')",[leadId,workspaceId,projectId,contactId,actorId]);
});
after(async()=>{if(db)await db.stop();if(root&&path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'lead-request-'))await rm(root,{recursive:true,force:true});for(const[key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
test('a real request requires truthful privacy settings; its capability contains no old customer fields or plain token in receipts',async()=>{
 await assert.rejects(command((tx,fresh)=>repository.createCustomerRequest(tx,fresh,{leadId,purpose:'contact_details',language:'en'})),/Datenschutz/);
 await command((tx,fresh)=>repository.saveCustomerRequestSettings(tx,fresh,{controller:'Synthetic Realty Ltd.',privacyUrl:'https://qa.invalid/privacy'}));
 const request=await create('contact_details'),info=await repository.lookupPublicCustomerRequest(request.token,query);assert.equal(info?.language,'en');assert.equal(info?.controller,'Synthetic Realty Ltd.');assert.doesNotMatch(JSON.stringify(info),/Original private|old-buyer|Original confidential/);
 const row=(await db.admin.query('select token_hash,token_ciphertext from lead_customer_requests where id=$1',[request.id])).rows[0];assert.notEqual(row.token_hash,request.token);assert.ok(!row.token_ciphertext.includes(request.token));
 assert.ok(!(await db.admin.query('select response::text as result from crm_command_receipts where workspace_id=$1',[workspaceId])).rows.some(row=>row.result.includes(request.token)));
 assert.equal((await db.pool.query('select id from lead_customer_requests')).rowCount,0);
});
test('public submission persists pending only; identical retry succeeds once and changed replay is refused',async()=>{
 const request=await create('contact_details'),key=randomUUID(),first=await repository.submitPublicCustomerRequest(request.token,key,details,undefined,query),again=await repository.submitPublicCustomerRequest(request.token,key,details,undefined,query);assert.equal(first.reference,again.reference);
 assert.equal((await db.admin.query('select name from contacts where id=$1',[contactId])).rows[0].name,'Original private name');
 assert.equal((await db.admin.query('select status from lead_customer_request_submissions where request_id=$1',[request.id])).rows[0].status,'pending');
 await assert.rejects(repository.submitPublicCustomerRequest(request.token,key,{...details,name:'Changed'},undefined,query),/bereits/);
 const contexts=await db.pool.query("select current_setting('app.tenant_id',true) tenant,current_setting('app.actor_id',true) actor,current_setting('app.lead_request_hash',true) capability");for(const value of Object.values(contexts.rows[0]))assert.ok(value===null||value==='');
});
test('only assigned staff can review; acceptance updates the authoritative contact with a recorded version',async()=>{
 const request=await create('contact_details'),submission=await repository.submitPublicCustomerRequest(request.token,randomUUID(),details,undefined,query);await assert.rejects(repository.getCustomerRequestState(limited,leadId,options),/Interessentenakte/);
 await command((tx,fresh)=>repository.reviewCustomerRequestSubmission(tx,fresh,{leadId,submissionId:submission.reference!,expectedVersion:1,accept:true,reason:'Synthetic self-reported contact checked by adviser'}));
 assert.equal((await db.admin.query('select name,email from contacts where id=$1',[contactId])).rows[0].email,details.email);
 await assert.rejects(command((tx,fresh)=>repository.reviewCustomerRequestSubmission(tx,fresh,{leadId,submissionId:submission.reference!,expectedVersion:1,accept:false,reason:'Synthetic stale review must fail'})),/bearbeitet/);
});
test('revocation, expiry, removed creator access and sample flags all close the capability',async()=>{
 const request=await create('contact_details');await command((tx,fresh)=>repository.revokeCustomerRequest(tx,fresh,leadId,request.id));assert.equal(await repository.lookupPublicCustomerRequest(request.token,query),null);await assert.rejects(repository.submitPublicCustomerRequest(request.token,randomUUID(),details,undefined,query),/nicht verfügbar/);
 const expiring=await create('contact_details');await db.admin.query('alter table lead_customer_requests disable trigger request_staff_guard');await db.admin.query("update lead_customer_requests set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expiring.id]);await db.admin.query('alter table lead_customer_requests enable trigger request_staff_guard');assert.equal(await repository.lookupPublicCustomerRequest(expiring.token,query),null);
 const access=await create('contact_details');await db.admin.query("update workspace_users set status='suspended' where id=$1",[actorId]);assert.equal(await repository.lookupPublicCustomerRequest(access.token,query),null);await db.admin.query("update workspace_users set status='active' where id=$1",[actorId]);
 await db.admin.query("update leads set metadata=jsonb_build_object('onboardingExample',jsonb_build_object('synthetic',true)) where id=$1",[leadId]);assert.equal(await repository.lookupPublicCustomerRequest(access.token,query),null);await assert.rejects(create('contact_details'),/Beispieldaten/);await db.admin.query("update leads set metadata='{}' where id=$1",[leadId]);
});
test('a submitted search profile is applied only after review and then produces its real completion event',async()=>{
 const request=await create('search_profile'),submission=await repository.submitPublicCustomerRequest(request.token,randomUUID(),profile,undefined,query);assert.equal((await db.admin.query('select id from buyer_search_profiles where buyer_lead_id=$1',[leadId])).rowCount,0);
 await command((tx,fresh)=>repository.reviewCustomerRequestSubmission(tx,fresh,{leadId,submissionId:submission.reference!,expectedVersion:1,accept:true,reason:'Synthetic Ireland property search confirmed with adviser'}));
 assert.equal((await qualification.getLeadQualification(session,leadId,options)).profile.countryCode,'IE');assert.equal((await db.admin.query("select id from crm_automation_events where lead_id=$1 and trigger_key='search_profile_completed'",[leadId])).rowCount,1);
});
test('proof intake is private and idempotent; adoption creates a pending proof, not a financial approval',async()=>{
 const request=await create('purchasing_power'),key=randomUUID(),payload={note:'Synthetic evidence for adviser',privacyRead:true},first=await repository.submitPublicCustomerRequest(request.token,key,payload,pdf(),query),again=await repository.submitPublicCustomerRequest(request.token,key,payload,pdf(),query);assert.equal(first.reference,again.reference);
 assert.equal((await db.admin.query('select id from lead_qualification_proofs where lead_id=$1',[leadId])).rowCount,0);assert.equal((await db.admin.query('select id from media_assets where workspace_id=$1',[workspaceId])).rowCount,0);
 await assert.rejects(repository.getCustomerRequestSubmissionUpload(limited,first.reference!,options),/nicht verfügbar|Interessentenakte/);
 const upload=await repository.getCustomerRequestSubmissionUpload(session,first.reference!,options);assert.equal(upload.name,'synthetic.pdf');
 const reviewed=await command((tx,fresh)=>repository.reviewCustomerRequestSubmission(tx,fresh,{leadId,submissionId:first.reference!,expectedVersion:1,accept:true,reason:'Synthetic uploaded document assigned to requested purpose'}));assert.ok(reviewed.data.proofNeedsReview);
 const proofs=(await qualification.getLeadQualification(session,leadId,options)).proofs;assert.equal(proofs[0].status,'pending');assert.ok(proofs[0].available);assert.ok(await qualification.getLeadProofAsset(session,proofs[0].id,options));
 await assert.rejects(repository.getCustomerRequestSubmissionUpload(session,first.reference!,options),/nicht verfügbar/);assert.equal((await db.admin.query("select id from crm_automation_events where lead_id=$1 and trigger_key='proof_uploaded'",[leadId])).rowCount,1);
});
test('malformed files, missing privacy acknowledgement and forged private locations never create a submission',async()=>{
 const request=await create('purchasing_power');await assert.rejects(repository.submitPublicCustomerRequest(request.token,randomUUID(),{privacyRead:true},new File(['not-pdf'],'bad.pdf',{type:'application/pdf'}),query),/content/);
 await assert.rejects(repository.submitPublicCustomerRequest(request.token,randomUUID(),{privacyRead:false},pdf(),query),/privacy/);
 const hash=(await db.admin.query('select token_hash from lead_customer_requests where id=$1',[request.id])).rows[0].token_hash;
 const result=await query("select crm_lead_request_submit($1,$2,repeat('a',64),'{\"privacyRead\":true}', '{}'::jsonb) as result",[hash,randomUUID()]);assert.equal((result?.result as{error:string}).error,'invalid_file');
 assert.equal((await db.admin.query('select id from lead_customer_request_submissions where request_id=$1',[request.id])).rowCount,0);
});
test('concurrent identical proof uploads retain only the file referenced by their one submission',async()=>{
 const request=await create('purchasing_power'),key=randomUUID();let lookups=0,release:()=>void=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;});
 const racingQuery=async(sql:string,params:unknown[])=>{const row=await query(sql,params);if(sql.includes('crm_lead_request_lookup')){lookups++;if(lookups===2)release();await barrier;}return row;};
 const [a,b]=await Promise.all([repository.submitPublicCustomerRequest(request.token,key,{privacyRead:true},pdf(),racingQuery),repository.submitPublicCustomerRequest(request.token,key,{privacyRead:true},pdf(),racingQuery)]);assert.equal(a.reference,b.reference);
 const files=await readdir(path.join(root,'uploads',workspaceId,`lead-proof-private-${leadId}`));assert.equal(files.filter(name=>name.startsWith(`pending-${request.id}-`)).length,1);
});
test('file removal has durable intent, survives an interrupted final acknowledgement, and never removes an adopted proof',async()=>{
 const request=await create('purchasing_power'),submitted=await repository.submitPublicCustomerRequest(request.token,randomUUID(),{privacyRead:true},pdf(),query),submissionId=submitted.reference!,metadata={idempotencyKey:randomUUID(),correlationId:randomUUID()};
 await command((tx,fresh)=>repository.reviewCustomerRequestSubmission(tx,fresh,{leadId,submissionId,expectedVersion:1,accept:false,reason:'Synthetic document unnecessary and rejected by adviser'}));
 const upload=(await db.admin.query('select file from lead_customer_request_submissions where id=$1',[submissionId])).rows[0].file;const target=path.join(root,'uploads',...upload.pathname.split('/'));assert.ok(await readFile(target));
 await db.admin.query("create function qa_interrupt_request_purge() returns trigger language plpgsql as $$ begin if new.file_purged_at is not null then raise exception 'synthetic interrupted completion';end if;return new;end $$;create trigger qa_interrupt_request_purge before update on lead_customer_request_submissions for each row execute function qa_interrupt_request_purge()");
 await assert.rejects(repository.purgeCustomerRequestSubmissionFile(session,{leadId,submissionId,reason:'Synthetic rejected file no longer needed'},metadata,options),/interrupted/);await assert.rejects(readFile(target));
 assert.equal((await repository.getCustomerRequestState(session,leadId,options)).submissions.find(s=>s.id===submissionId)?.filePurgeStarted,true);
 await db.admin.query('drop trigger qa_interrupt_request_purge on lead_customer_request_submissions;drop function qa_interrupt_request_purge()');
 const result=await repository.purgeCustomerRequestSubmissionFile(session,{leadId,submissionId,reason:'Synthetic rejected file no longer needed'},metadata,options);assert.ok(result.data.purged);
 assert.ok((await repository.getCustomerRequestState(session,leadId,options)).submissions.find(s=>s.id===submissionId)?.filePurgedAt);
 const adopted=(await db.admin.query('select id from lead_customer_request_submissions where adopted_proof_id is not null limit 1')).rows[0].id;
 await assert.rejects(repository.purgeCustomerRequestSubmissionFile(session,{leadId,submissionId:adopted,reason:'Synthetic forbidden deletion of adopted proof'},{idempotencyKey:randomUUID(),correlationId:randomUUID()},options),/übernommene/);
});
test('actual streamed HTTP byte limits apply without a Content-Length header',async()=>{
 const {readCustomerRequestBody}=await import('../src/lib/lead-customer-request-http');const request=new Request('https://qa.invalid',{method:'POST',body:new Uint8Array(25000)});await assert.rejects(readCustomerRequestBody(request,20000),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===413);
});
test('the actual public route accepts configured origin through internal host rewriting and rejects missing or cross-site origin',async()=>{
 const original=process.env.NOVALURE_APP_ORIGIN;process.env.NOVALURE_APP_ORIGIN='http://127.0.0.1:58452';
 try{const {POST}=await import('../src/app/api/public/lead-requests/[token]/route');const context={params:Promise.resolve({token:'invalid'})};
  const trusted=await POST(new Request('http://localhost:58452/api/public/lead-requests/invalid',{method:'POST',headers:{origin:'http://127.0.0.1:58452','Content-Type':'application/json'},body:'{'}),context);assert.equal(trusted.status,400);
  for(const headers of[{}, {origin:'https://other.invalid'},{origin:'http://127.0.0.1:58452','sec-fetch-site':'cross-site'}] as Record<string,string>[]){const rejected=await POST(new Request('http://localhost:58452/api/public/lead-requests/invalid',{method:'POST',headers,body:'{}'}),context);assert.equal(rejected.status,403);}
 }finally{if(original===undefined)delete process.env.NOVALURE_APP_ORIGIN;else process.env.NOVALURE_APP_ORIGIN=original;}
});
test('a saved active request node makes a real expiring customer form in the selected language',async()=>{
 const {createAutomationGraph}=await import('../src/lib/automation/graph');const graph=createAutomationGraph();graph.businessHours=false;graph.nodes=[{id:'start',type:'start',title:'Start'},{id:'request',type:'request',title:'Request profile',subject:'Requested search profile',body:'Please provide your property preferences.',request:'search_profile',language:'es'},{id:'end',type:'stop',title:'End'}];graph.edges=[{from:'start',to:'request',port:'next'},{from:'request',to:'end',port:'next'}];
 const saved=await command((tx,fresh)=>automation.saveAutomation(tx,fresh,{projectId,name:'Synthetic requested profile',graph}));await command((tx,fresh)=>automation.setAutomationStatus(tx,fresh,{id:saved.data.id,expectedRevision:1,active:true}));
 await command(tx=>automation.recordAutomationEvent(tx,{workspaceId,projectId,leadId,eventId:randomUUID(),trigger:'new_lead'}));const tick=await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,saved.data.id));assert.equal(tick.data.outcomes[0].status,'review');
 const draft=(await db.admin.query('select id from crm_automation_drafts where workspace_id=$1 order by created_at desc limit 1',[workspaceId])).rows[0];const link=await withCrmRead(session,(tx,fresh)=>repository.getAutomationCustomerRequestLink(tx,fresh,draft.id,'https://qa.invalid'),options);assert.ok(link?.url.startsWith('https://qa.invalid/request/'));
 const token=link!.url.split('/').pop()!,info=await repository.lookupPublicCustomerRequest(token,query);assert.equal(info?.language,'es');assert.equal(info?.submitted,false);assert.equal(link?.purpose,'search_profile');
 await repository.submitPublicCustomerRequest(token,randomUUID(),profile,undefined,query);assert.equal(await withCrmRead(session,(tx,fresh)=>repository.getAutomationCustomerRequestLink(tx,fresh,draft.id,'https://qa.invalid'),options),null);
});
