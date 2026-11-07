import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {withCrmRead} from '../src/lib/crm-command';
import {createCsrfToken} from '../src/lib/security/csrf-core';
import {closeLocalTestPool} from '../src/lib/db/local-test-transport';
import {GET,POST} from '../src/app/api/crm/properties/route';
import {assignPropertyInquiry,parsePropertyInquiryAssignment,readPropertyInquiryAssignments} from '../src/lib/db/property-inquiry-assignment-repository';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';

let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const w=randomUUID(),foreignW=randomUUID(),owner=randomUUID(),agent=randomUUID(),other=randomUUID(),foreignActor=randomUUID(),project=randomUUID(),hiddenProject=randomUUID(),foreignProject=randomUUID();
const property=randomUUID(),secondProperty=randomUUID(),hiddenProperty=randomUUID(),foreignProperty=randomUUID(),unit=randomUUID(),wrongUnit=randomUUID(),hiddenUnit=randomUUID();
const options=()=>({pool:db.pool as unknown as TenantPool});
const metadata=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
const session=(actor=agent,role:AppSession['role']='agent',productRole:AppSession['productRole']='project_sales_member'):AppSession=>({authenticated:true,workspaceId:w,userId:actor,workspaceName:'SYNTHETIC Assignment',name:'SYNTHETIC actor',email:'actor@example.invalid',role,productRole,permissions:[],productPermissions:[],source:'database'});
async function leadFixture({workspace=w,target=project,leadOwner=agent,contactOwner=agent,classification='CUSTOMER_TENANT'}={}){const leadId=randomUUID(),contactId=randomUUID();await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,role,data_classification) values($1,$2,$3,$4,'SYNTHETIC Inquiry contact','Käufer',$5)",[contactId,workspace,target,contactOwner,classification]);await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,data_classification) values($1,$2,$3,$4,$5,'Käufer',$6)",[leadId,workspace,target,contactId,leadOwner,classification]);return {leadId,contactId};}
const input=(leadId:string,propertyId=property,unitId:string|null=unit,expectedVersion:string|null=null)=>parsePropertyInquiryAssignment({operation:'assign_inquiry',leadId,propertyId,unitId,expectedVersion,confirmed:true});

test('assignment accepts only explicit scope, confirmation and comparison revision, never source or authority overrides',()=>{const valid={leadId:randomUUID(),propertyId:randomUUID(),unitId:null,expectedVersion:null,confirmed:true};assert.equal(parsePropertyInquiryAssignment(valid).expectedVersion,null);for(const patch of [{confirmed:false},{confirmed:'true'},{expectedVersion:0},{expectedVersion:'0'},{expectedVersion:'1 OR 1=1'},{expectedVersion:'2147483647'},{unitId:undefined},{workspaceId:randomUUID()},{projectId:randomUUID()},{contactId:randomUUID()},{source:'trusted'}])assert.throws(()=>parsePropertyInquiryAssignment({...valid,...patch}));});
before(async()=>{
 db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const migration of ['155_web_expose.sql','171_property_inquiry_assignments.sql'])await db.admin.query(await readFile('migrations/'+migration,'utf8'));
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Assignment','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,foreignW]);
 for(const [id,workspace,name,role,productRole] of [[owner,w,'Owner','owner','customer_owner'],[agent,w,'Agent','agent','project_sales_member'],[other,w,'Other','agent','project_sales_member'],[foreignActor,foreignW,'Foreign','owner','customer_owner']])await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')",[id,workspace,'SYNTHETIC '+name,String(name)+'@example.invalid',role,productRole]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Granted','Test'),($2,$4,'SYNTHETIC Hidden','Test'),($3,$5,'SYNTHETIC Foreign','Test')",[project,hiddenProject,foreignProject,w,foreignW]);
 await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[w,project,agent]);
 for(const [id,workspace,target,title] of [[property,w,project,'A'],[secondProperty,w,project,'B'],[hiddenProperty,w,hiddenProject,'Hidden'],[foreignProperty,foreignW,foreignProject,'Foreign']])await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm) values($1,$2,$3,$4,'SYNTHETIC address','SYNTHETIC Region','Wohnung',82)",[id,workspace,target,'SYNTHETIC '+title]);
 for(const [id,parent,hidden] of [[unit,property,false],[wrongUnit,secondProperty,false],[hiddenUnit,property,true]])await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,metadata) values($1,$2,$3,$4,'available',$5::jsonb)",[id,w,project,'SYNTHETIC-'+String(id).slice(0,8),JSON.stringify({sellerListingId:parent,hidden})]);
});
after(async()=>{if(db)await db.stop();});

test('candidate reader follows actual tenant, project, lead assignment, contact ownership and classification',async()=>{
 const valid=await leadFixture(),others=await Promise.all([leadFixture({leadOwner:other}),leadFixture({contactOwner:other}),leadFixture({target:hiddenProject}),leadFixture({classification:'PRIVATE_FRANZ'}),leadFixture({workspace:foreignW,target:foreignProject,leadOwner:foreignActor,contactOwner:foreignActor})]);
 const result=await readPropertyInquiryAssignments(session(),project,options());assert.ok(result.candidates.some(row=>row.leadId===valid.leadId));for(const target of others)assert.ok(!result.candidates.some(row=>row.leadId===target.leadId));await assert.rejects(readPropertyInquiryAssignments(session(),hiddenProject,options()));
});

test('confirmed rerouting persists a separate current relation and append-only history without rewriting original inquiries or sales',async()=>{
 const f=await leadFixture(),original=randomUUID();await db.admin.query("insert into property_inquiries(id,workspace_id,property_id,project_id,lead_id,contact_id,source_channel,campaign) values($1,$2,$3,$4,$5,$6,'SYNTHETIC Original','SYNTHETIC Campaign')",[original,w,property,project,f.leadId,f.contactId]);
 const before=(await db.admin.query('select * from property_inquiries where id=$1',[original])).rows[0];const first=await assignPropertyInquiry(session(),input(f.leadId),metadata(),options());assert.equal(first.data.assignment?.version,'1');assert.equal(first.data.assignment?.unitId,unit);
 const second=await assignPropertyInquiry(session(),input(f.leadId,secondProperty,null,'1'),metadata(),options());assert.equal(second.data.assignment?.version,'2');assert.equal(second.data.assignment?.propertyId,secondProperty);assert.equal(second.data.assignment?.unitId,null);
 assert.deepEqual((await db.admin.query('select * from property_inquiries where id=$1',[original])).rows[0],before);
 const history=(await db.admin.query('select version,property_id,unit_id,confirmed_by from property_inquiry_assignment_history where workspace_id=$1 and lead_id=$2 order by version',[w,f.leadId])).rows;assert.deepEqual(history.map(row=>row.version),[1,2]);assert.equal(history[0].unit_id,unit);assert.equal(history[1].confirmed_by,agent);assert.equal((await db.admin.query('select action from audit_logs where id=$1',[second.auditReference])).rows[0].action,'crm.inquiry.assign');assert.equal((await db.admin.query('select count(*) from deals where workspace_id=$1 and lead_id=$2',[w,f.leadId])).rows[0].count,'0');assert.equal((await db.admin.query('select count(*) from property_reservations where workspace_id=$1',[w])).rows[0].count,'0');
});

test('concurrent retries commit once; changed retry and stale or parallel comparison snapshots cannot silently replace routing',async()=>{
 const f=await leadFixture(),meta=metadata(),command=input(f.leadId);const results=await Promise.all([assignPropertyInquiry(session(),command,meta,options()),assignPropertyInquiry(session(),command,meta,options())]);assert.deepEqual(results[0].data,results[1].data);assert.equal(results.filter(result=>result.replayed).length,1);
 await assert.rejects(assignPropertyInquiry(session(),input(f.leadId,secondProperty,null),meta,options()),/different command/);
 const raced=await Promise.allSettled([assignPropertyInquiry(session(),input(f.leadId,secondProperty,null,'1'),metadata(),options()),assignPropertyInquiry(session(),input(f.leadId,property,null,'1'),metadata(),options())]);assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);assert.equal(raced.filter(result=>result.status==='rejected').length,1);assert.equal((await db.admin.query('select count(*) from property_inquiry_assignment_history where workspace_id=$1 and lead_id=$2',[w,f.leadId])).rows[0].count,'2');
});

test('foreign or mismatched project/property/unit, hidden unit and missing write grant fail closed including receipt replay',async()=>{
 const f=await leadFixture();for(const command of [input(f.leadId,hiddenProperty,null),input(f.leadId,foreignProperty,null),input(f.leadId,property,wrongUnit),input(f.leadId,property,hiddenUnit)])await assert.rejects(assignPropertyInquiry(session(),command,metadata(),options()));const meta=metadata(),command=input(f.leadId);await assignPropertyInquiry(session(),command,meta,options());await db.admin.query('update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3',[w,project,agent]);try{await assert.rejects(assignPropertyInquiry(session(),command,meta,options()));}finally{await db.admin.query('update project_pipeline_permissions set can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3',[w,project,agent]);}
});

test('database guards reject scope mutation, revision jumps and forged or rewritten history under real non-bypass runtime',async()=>{
 const f=await leadFixture(),saved=await assignPropertyInquiry(session(),input(f.leadId),metadata(),options()),id=saved.data.assignment!.id;
 for(const mutation of ["update property_inquiry_assignments set project_id=null,version=version+1 where id=$1::uuid","update property_inquiry_assignments set property_id=property_id,version=version+2 where id=$1::uuid","delete from property_inquiry_assignment_history where assignment_id=$1::uuid","update property_inquiry_assignment_history set property_id=property_id where assignment_id=$1::uuid"]){await assert.rejects(withCrmRead(session(),tx=>tx.execute(mutation,[id]),options()));}
 await assert.rejects(withCrmRead(session(),tx=>tx.execute('insert into property_inquiry_assignment_history select workspace_id,id,project_id,lead_id,property_id,unit_id,version+1,confirmed_by,confirmed_at,data_classification,data_purpose from property_inquiry_assignments where id=$1::uuid',[id]),options()));
 await assert.rejects(withCrmRead(session(),tx=>tx.execute('insert into property_inquiry_assignments(workspace_id,project_id,lead_id,property_id,confirmed_by) values($1,$2,$3,$4,$5)',[w,project,(randomUUID()),foreignProperty,agent]),options()));
});

test('actual cookie route enforces endpoint CSRF and idempotency headers, returns persisted DTO and rejects ambiguous workspace',async()=>{
 const names=['NODE_ENV','DATABASE_URL','CRM_LOCAL_TEST_DATABASE','NOVALURE_SESSION_SECRET','NOVALURE_APP_ORIGIN','NOVALURE_AUTH_STRICT','NOVALURE_AUTH_ENCRYPTION_KEY','NOVALURE_AUTH_RATE_LIMIT_SECRET'],old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const origin='http://127.0.0.1:3000',secret=randomBytes(48).toString('base64url'),cookie='v2.'+randomBytes(32).toString('base64url'),path='/api/crm/properties',meta=metadata(),f=await leadFixture(),body={operation:'assign_inquiry',...input(f.leadId)};
 try{
  Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,CRM_LOCAL_TEST_DATABASE:'1',NOVALURE_SESSION_SECRET:secret,NOVALURE_APP_ORIGIN:origin,NOVALURE_AUTH_STRICT:'1',NOVALURE_AUTH_ENCRYPTION_KEY:randomBytes(40).toString('hex'),NOVALURE_AUTH_RATE_LIMIT_SECRET:randomBytes(40).toString('hex')});
  const identity=(await db.admin.query('select auth_identity_id from workspace_users where id=$1',[owner])).rows[0].auth_identity_id;
  await db.admin.query("update auth_identities set credential_state='active' where id=$1",[identity]);await db.admin.query(`grant select on auth_identities to ${db.role}`);
  await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",[randomUUID(),createHash('sha256').update(cookie).digest('hex'),identity,owner,w]);
  const headers={cookie:'novalure_session='+cookie,origin,'sec-fetch-site':'same-origin','Content-Type':'application/json','Idempotency-Key':meta.idempotencyKey,'X-Correlation-Id':meta.correlationId};
  const post=(csrf:boolean)=>POST(new Request(`${origin}${path}?workspaceId=${w}`,{method:'POST',headers:{...headers,...(csrf?{'x-novalure-csrf-token':createCsrfToken({method:'POST',pathname:path,secret,sessionCookie:cookie})!.token}:{})},body:JSON.stringify(body)}));
  assert.equal((await post(false)).status,403);const first=await post(true);assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).persisted,true);const replay=await post(true);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  const read=await GET(new Request(`${origin}${path}?workspaceId=${w}&operation=inquiry_assignments&projectId=${project}`,{headers:{cookie:headers.cookie}}));assert.equal(read.status,200,await read.clone().text());assert.ok((await read.json()).data.candidates.some((row:{leadId:string})=>row.leadId===f.leadId));
  assert.equal((await GET(new Request(`${origin}${path}?workspaceId=${w}&workspaceId=${foreignW}&operation=inquiry_assignments`,{headers:{cookie:headers.cookie}}))).status,400);
 }finally{await closeLocalTestPool();for(const name of names)if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}
});
