import { randomUUID,generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AppSession } from '../../src/lib/auth/session';
import { getRolePermissions } from '../../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../../src/lib/product-model';
import type { TenantPool } from '../../src/lib/db/tenant-client';
import { startLocalSalesDb,applySalesSchema } from './local-sales-db.mjs';
import { closeLocalTestPool } from '../../src/lib/db/local-test-transport';
import { runWebsiteSalesIrelandCommand,websiteSalesIrelandContract,type WebsiteSalesIrelandCommand } from '../../src/lib/db/website-sales-ireland-repositories';
import { CRM_MACHINE_WORKSPACE_ID,CRM_MACHINE_ISSUER,CRM_MACHINE_AUDIENCE,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_SUBJECT,CRM_MACHINE_ENVIRONMENT } from '../../src/lib/crm-machine-auth';
import { executeWebsiteSalesAdvisoryCommand,readWebsiteSalesAdvisory } from '../../src/lib/db/website-sales-advisory-repositories';
import { createWebsiteSalesAdvisoryExecutor } from '../../src/lib/db/website-sales-advisory-jobs';
import { websiteSalesAdvisoryContract,type WebsiteSalesAdvisoryCommand } from '../../src/lib/website-sales-advisory-types';
export async function createAdvisoryFixture(){
 const db=await startLocalSalesDb();let executorPool:Pool|undefined;
 const savedEnv={DATABASE_URL:process.env.DATABASE_URL,CRM_LOCAL_TEST_DATABASE:process.env.CRM_LOCAL_TEST_DATABASE,NODE_ENV:process.env.NODE_ENV};
 Object.assign(process.env,{DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,CRM_LOCAL_TEST_DATABASE:'1',NODE_ENV:'test'});
 try{
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  for (const file of ['202_website_sales_ireland.sql', '170_crm_personal_mailbox.sql', '203_website_sales_machine.sql', '204_website_sales_studio.sql', '205_website_sales_lifecycle.sql', '206_website_sales_operations.sql', '207_website_sales_conversations.sql', '208_website_sales_enablement.sql','209_website_sales_commerce.sql','210_website_sales_advisory.sql']) await db.admin.query(await readFile(`migrations/${file}`, 'utf8'));
  const ws = CRM_MACHINE_WORKSPACE_ID, actor = randomUUID(), otherWs = randomUUID(), otherActor = randomUUID(), project = randomUUID(), pipeline = randomUUID(), company = randomUUID(), contact = randomUUID(), second = randomUUID(), secondContact = randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'Isolated enablement','novalure_internal','novalure_internal'),($2,'Foreign tenant','novalure_internal','novalure_internal') on conflict(id) do nothing", [ws, otherWs]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'Isolated owner','enablement-owner@example.invalid','owner','novalure_operator'),($3,$4,'Foreign owner','enablement-foreign@example.invalid','owner','novalure_operator')", [actor, ws, otherActor, otherWs]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Enablement','Website','WEB_DESIGN')", [project, ws]);
  await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'enablement-test','Existing Website Pipeline','novalure_internal',true)", [pipeline, ws, project]);
  for (const [i, stage] of ['Qualifizieren', 'Gewonnen', 'Verloren'].entries()) await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,$4,$5,$6,$7)", [pipeline, ws, project, i === 0 ? 'qualify' : stage.toLowerCase(), stage, i, i === 1 ? 'won' : i === 2 ? 'lost' : 'work']);
  await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [project, pipeline]);
  for (const [id, buyer, name] of [[company, contact, 'Canonical Company'], [second, secondContact, 'Other Company']]) {
   await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN')", [id, ws, project, name]);
   await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,email,role) values($1,$2,$3,$4,'Canonical Buyer',$5,'Ansprechpartner')", [buyer, ws, project, id, `${buyer}@example.invalid`]);
  }
  const session: AppSession = { authenticated: true, source: 'database', workspaceId: ws, userId: actor, workspaceName: 'Isolated enablement', name: 'Isolated owner', email: 'enablement-owner@example.invalid', role: 'owner', productRole: 'novalure_operator', permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('novalure_operator') }, foreign = { ...session, workspaceId: otherWs, userId: otherActor };
  const opts = { pool: db.pool as unknown as TenantPool }, future = new Date(Date.now() + 86400000).toISOString(), past = new Date(Date.now() - 60000).toISOString();
  const irish = (operation: WebsiteSalesIrelandCommand['operation'], payload: Record<string, unknown>, extra: Partial<WebsiteSalesIrelandCommand> = {}) => runWebsiteSalesIrelandCommand(session, { contractVersion: websiteSalesIrelandContract, operation, projectId: project, companyId: company, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload, ...extra }, opts);
  const registered = await irish('register_location', { countryCode: 'IE', address: '1 Isolated Street, Dublin, Ireland', sourceUrl: 'https://example.invalid/company', sourceReference: 'Synthetic owner-registered location' }), location = registered.data.location.id;
  const scope = { projectId: project, companyId: company, locationId: location }, identity = { workspaceId: ws, ...scope };
  const prospect = { identity, country: 'IRELAND', identityStatus: 'VERIFIED', domain: null, path: 'NO_WEBSITE', ownWebsiteSearch: 'NONE_FOUND', obstacle: null, platformUrl: null, bookingRoute: 'UNKNOWN', need: 'EVIDENCED', evidence: ['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED'].map(kind => ({ evidenceId: kind, identity, kind, sourceUrl: `https://example.invalid/evidence/${kind}`, observedAt: past, validUntil: future, validityCondition: 'Synthetic evidence remains current', finding: 'Synthetic source-bound business need', confidence: 0.9 })) };
  const observed = await irish('observe', { prospect }, { locationId: location, locationVersion: 1 });
  const qualified = await irish('qualify', { contactId: contact, opportunitySummary: 'Synthetic canonical company opportunity', nextAction: 'Review current scope', expectedEvidenceDigest: observed.data.workflow!.evidenceDigest }, { locationId: location, expectedVersion: 1 });
  const wf = qualified.data.workflow!;

 const fullScope={...scope,workflowId:wf.id};
 const makeCommand=async(operation:WebsiteSalesAdvisoryCommand['operation'],payload:Record<string,unknown>):Promise<WebsiteSalesAdvisoryCommand>=>{const current=await readWebsiteSalesAdvisory(session,fullScope,opts);return {contractVersion:websiteSalesAdvisoryContract,operation,...fullScope,expectedVersion:current.version,expectedWorkflowVersion:current.workflowVersion,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload};};
 const run=async(operation:WebsiteSalesAdvisoryCommand['operation'],payload:Record<string,unknown>)=>executeWebsiteSalesAdvisoryCommand(session,await makeCommand(operation,payload),opts);
 const agent=randomUUID();await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role)values($1,$2,'SYNTHETIC executor','advisory-executor@example.invalid','agent','novalure_operator')",[agent,ws]);
 await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)values($1,$2,$3,true,true)',[ws,project,agent]);
 const workload=randomUUID(),grant=randomUUID(),keys=generateKeyPairSync('ed25519'),authorityReference='SYNTHETIC advisory executor';
 await db.admin.query(`insert into crm_website_sales_machine_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference)values($1,'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[workload,ws,agent,CRM_MACHINE_ISSUER,CRM_MACHINE_AUDIENCE,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_SUBJECT,CRM_MACHINE_ENVIRONMENT,authorityReference]);
 const scopes=['crm.website-sales.advisory.read','crm.website-sales.advisory.process-job','crm.website-sales.studio.read','crm.website-sales.enablement.read'];
 await db.admin.query(`insert into crm_website_sales_machine_grants(id,workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,not_before,expires_at)values($1,$2,$3,$4,$5,$6,$7,'SALES','evelyn.sales.advisory-native',$8,$9,$10,$11,clock_timestamp(),$12)`,[grant,workload,ws,agent,project,company,location,randomUUID(),authorityReference,keys.publicKey.export({format:'der',type:'spki'}).toString('base64url'),scopes,future]);
 await db.admin.query('create role advisory_private_executor login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant novalure_website_sales_advisory_executor to advisory_private_executor');
 executorPool=new Pool({host:'127.0.0.1',port:db.port,user:'advisory_private_executor',database:'postgres',max:4});
 const binding={...fullScope,workspaceId:ws,actorId:agent,workloadId:workload,grantId:grant,allowedKinds:['ADVICE','TRANSCRIPT_ANALYSIS','ROLEPLAY','VIDEO'] as const,expiresAt:Date.parse(future),authorityReference};
 const executor=createWebsiteSalesAdvisoryExecutor({pool:executorPool as unknown as TenantPool,assertCurrent:async()=>binding});
 const source={id:randomUUID(),reference:'operator-recorded:SYNTHETIC advisory source',digest:'a'.repeat(64),basis:'OPERATOR_RECORDED',observedAt:past,validUntil:future};
 const close=async()=>{await executorPool?.end();await closeLocalTestPool();for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;await db.stop();};
 return {db,foreign,pool:db.pool,adminPool:db.admin,session,scope:fullScope,opts,source,future,past,actor,ws,project,company,contact,second,secondContact,workload,grant,executor,executorPool,binding,makeCommand,run,read:()=>readWebsiteSalesAdvisory(session,fullScope,opts),close};
 }catch(error){await executorPool?.end();await db.stop();for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;throw error;}
}

export async function prepareAdvisoryAdviceFixture(f:Awaited<ReturnType<typeof createAdvisoryFixture>>){
 const k=await f.run('register_knowledge',{title:'SYNTHETIC approved guidance',kind:'PLAYBOOK',content:'Explain the approved website scope and ask about unresolved needs.',disclosure:'INTERNAL',allowedUse:'ORIGINAL_NOVALURE',fullCopyrightedContentStored:false,rightsReference:f.source,criteria:[{id:'clarify',label:'Clarify needs',evidenceTerms:['needs']}],scenarios:[{id:'price',situation:'Fictional price conversation',customerOpening:'How does this help our customers?'}],sourceReferences:[f.source],validUntil:f.future});
 const ref={id:k.data.recordId!,version:1,digest:k.data.recordDigest!};await f.run('approve_knowledge',{recordRef:ref,validUntil:f.future});
 const view=await f.read();const facts=view.groundedFacts.filter(fact=>fact.evidenceRef.id===ref.id);if(!facts.length)throw Error('NATIVE_APPROVED_KNOWLEDGE_FACT_REQUIRED');
 const prepared=await f.run('prepare_advice',{kind:'WEBSITE',question:'What approved guidance helps us?',factRefs:[ref],artifactRefs:[],knowledgeRefs:[ref]});
 return {jobId:prepared.data.jobId!,knowledgeRef:ref,facts};
}
