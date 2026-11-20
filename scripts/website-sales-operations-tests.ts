import {websiteSalesAnswerFactSchema} from "../src/lib/website-sales-conversation";
import {websiteSalesPolicyDigest} from "../src/lib/website-sales-operations-contracts";
import {readSalesAcceptancePrice} from "../src/lib/db/website-sales-price-acceptance";
import {executeWebsiteSalesLifecycleCommand,readWebsiteSalesLifecycle} from "../src/lib/db/website-sales-lifecycle-repositories";
import {crmPayloadDigest} from "../src/lib/crm-command";
import {CRM_MACHINE_WORKSPACE_ID,CRM_MACHINE_AUDIENCE,CRM_MACHINE_ISSUER,CRM_MACHINE_SUBJECT,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_ENVIRONMENT} from "../src/lib/crm-machine-auth";
import {handleWebsiteSalesMachine,websiteSalesMachineContract,websiteSalesMachinePath,websiteSalesMachineDelegationDomain,websiteSalesMachineScopes} from "../src/lib/website-sales-machine";
import assert from "node:assert/strict";
import {randomUUID,generateKeyPairSync,sign} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import type {AppSession} from "../src/lib/auth/session";
import {getRolePermissions} from "../src/lib/auth/permissions";
import {getProductRoleCapabilities} from "../src/lib/product-model";
import type {TenantPool} from "../src/lib/db/tenant-client";
import {withCrmRead} from "../src/lib/crm-command";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {runWebsiteSalesIrelandCommand,websiteSalesIrelandContract,type WebsiteSalesIrelandCommand} from "../src/lib/db/website-sales-ireland-repositories";
import {executeSalesOperationsCommand as execute,readSalesOperations as read,reconcileSalesOperationsCommand as reconcile,readCurrentSalesPriceFact} from "../src/lib/db/website-sales-operations-repositories";
import {websiteSalesOperationsContract,type SalesOperationsCommand} from "../src/lib/website-sales-operations-types";
import {executeWebsiteSalesStudioCommand} from "../src/lib/db/website-sales-studio-repositories";

test("Canonical Sales operations reserve shared resources, revise only DRAFT, and learn from attributed actual sources",{timeout:240000},async t=>{
 const db=await startLocalSalesDb();
 try{
  await applySalesSchema(db,{maxMigrationNumber:90});
  for(const file of ["202_website_sales_ireland.sql","170_crm_personal_mailbox.sql","203_website_sales_machine.sql","204_website_sales_studio.sql","205_website_sales_lifecycle.sql","206_website_sales_operations.sql","207_website_sales_conversations.sql"]){await db.admin.query(await readFile(`migrations/${file}`,"utf8"));}
  const ws=CRM_MACHINE_WORKSPACE_ID,actor=randomUUID(),otherWs=randomUUID(),otherActor=randomUUID(),project=randomUUID(),companies:string[]=[randomUUID(),randomUUID()],contacts=[randomUUID(),randomUUID()],pipeline=randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type)values($1,'Isolated Sales operations','novalure_internal','novalure_internal'),($2,'Other tenant','novalure_internal','novalure_internal') on conflict(id) do nothing",[ws,otherWs]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role)values($1,$2,'Policy owner','owner@example.invalid','owner','novalure_operator'),($3,$4,'Other owner','other@example.invalid','owner','novalure_operator')",[actor,ws,otherActor,otherWs]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,division)values($1,$2,'Sales operations','Website','WEB_DESIGN')",[project,ws]);
  await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default)values($1,$2,$3,'ops-test','Operations existing pipeline','novalure_internal',true)",[pipeline,ws,project]);
  for(const [position,key]of ['request','qualify'].entries())await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category)values($1,$2,$3,$4,$4,$5,'work')",[pipeline,ws,project,key,position]);
  await db.admin.query("update projects set default_pipeline_id=$2 where id=$1",[project,pipeline]);
  for(let i=0;i<2;i++){await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division)values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN')",[companies[i],ws,project,`Canonical company ${i}`]);await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,name,role,email)values($1,$2,$3,$4,'Canonical buyer','Ansprechpartner',$5)",[contacts[i],ws,project,companies[i],`buyer${i}@example.invalid`]);}
  const session:AppSession={authenticated:true,source:'database',workspaceId:ws,userId:actor,workspaceName:'Isolated Sales',name:'Policy owner',email:'owner@example.invalid',role:'owner',productRole:'novalure_operator',permissions:getRolePermissions('owner'),productPermissions:getProductRoleCapabilities('novalure_operator')};
  const opts={pool:db.pool as unknown as TenantPool},future=new Date(Date.now()+86400000).toISOString(),past=new Date(Date.now()-60000).toISOString();
  const irish=(i:number,operation:WebsiteSalesIrelandCommand['operation'],payload:Record<string,unknown>,extra:Partial<WebsiteSalesIrelandCommand>={})=>runWebsiteSalesIrelandCommand(session,{contractVersion:websiteSalesIrelandContract,operation,projectId:project,companyId:companies[i],idempotencyKey:randomUUID(),correlationId:randomUUID(),payload,...extra},opts);
  const plan={requestedStage:'DIAGNOSIS',completedStage:'NONE',estimatedCostMinor:30,availableBudgetMinor:100,expectedNetPriceMinor:10000,estimatedDeliveryCostMinor:1000,minimumMarginBasisPoints:3000,requiredCapacityMinutes:10,availableCapacityMinutes:100,rightsVerified:true,budgetReference:'Isolated owner planning allocation'};
  const scopes:{projectId:string;companyId:string;locationId:string}[]=[];const flows:NonNullable<Awaited<ReturnType<typeof runWebsiteSalesIrelandCommand>>['data']['workflow']>[]=[];
  for(let i=0;i<2;i++){
   const r=await irish(i,'register_location',{countryCode:'IE',address:`${i+1} Test Street, Dublin, Ireland`,sourceUrl:'https://example.invalid/company',sourceReference:'Isolated operator-registered location'}),locationId=r.data.location.id,identity={workspaceId:ws,projectId:project,companyId:companies[i],locationId};scopes.push({projectId:project,companyId:companies[i],locationId});
   const prospect={identity,country:'IRELAND',identityStatus:'VERIFIED',domain:null,path:'NO_WEBSITE',ownWebsiteSearch:'NONE_FOUND',obstacle:null,platformUrl:null,bookingRoute:'UNKNOWN',need:'EVIDENCED',evidence:['IDENTITY','OWN_WEBSITE_SEARCH','BUSINESS_NEED'].map(kind=>({evidenceId:kind.toLowerCase(),identity,kind,sourceUrl:'https://example.invalid/evidence/'+kind,observedAt:past,validUntil:future,validityCondition:'Isolated source remains current',finding:'Isolated canonical business fact',confidence:0.9}))};
   const observed=await irish(i,'observe',{prospect,investmentPlan:plan},{locationId,locationVersion:1});const q=await irish(i,'qualify',{contactId:contacts[i],opportunitySummary:'Canonical opportunity',nextAction:'Internal research',expectedEvidenceDigest:observed.data.workflow!.evidenceDigest},{locationId,expectedVersion:observed.data.workflow!.version});flows.push(q.data.workflow!);
  }
  const command=(operation:SalesOperationsCommand['operation'],payload:Record<string,unknown>,expectedVersion=0,i=0):SalesOperationsCommand=>({contractVersion:websiteSalesOperationsContract,operation,...scopes[i],expectedVersion,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload});
  const portfolioRule={enabled:true,validFrom:past,validUntil:future,maxOpportunities:2,maxPerCompany:1,maxCostPerOpportunityMinor:40,maxMinutesPerOpportunity:20,minimumKnownSignals:2,minimumScore:1,weights:{FIT:5000,NEED:5000,INTENT:0,URGENCY:0,ENGAGEMENT:0}};
  let portfolioId='',allocationId='',portfolioVersion=1;
  await t.test('owner policy is immutable; machine cannot configure or assert policy authority',async()=>{
   const c=command('configure_portfolio',{title:'Shared research window',policy:portfolioRule,budgetMinor:50,capacityMinutes:15,windowStart:past,windowEnd:future,managedResources:scopes,stageEstimates:[{stage:'DIAGNOSIS',estimatedCostMinor:30,requiredMinutes:10}]});const r=await execute(session,c,opts);portfolioId=r.data.portfolioId!;assert.equal(r.data.workspaceId,ws);assert.equal((await execute(session,c,opts)).commandId,r.commandId);await assert.rejects(execute(session,{...c,payload:{...c.payload,budgetMinor:500}},opts),{code:'IDEMPOTENCY_CONFLICT'});
   assert.equal((await db.admin.query("select count(*)::int n from pg_class where relname like 'crm_website_sales_ops_%' and relrowsecurity and relforcerowsecurity")).rows[0].n,12);
  });
  await t.test('two companies share one atomically bounded budget/capacity and original cohort denominator',async()=>{
   const c=command('plan_portfolio',{portfolioId,candidates:flows.map((w,i)=>({...scopes[i],workflowId:w.id,expectedWorkflowVersion:w.version,expectedEvidenceDigest:w.evidenceDigest,requestedStage:'DIAGNOSIS',purpose:'INTERNAL_RESEARCH',dialogSourceId:null}))},portfolioVersion);const r=await execute(session,c,opts);portfolioVersion=r.data.version;assert.equal(r.data.allocationIds!.length,1);allocationId=r.data.allocationIds![0];
   const view=await read(session,scopes[0],opts);assert.equal(view.portfolio!.allocatedBudgetMinor,30);assert.equal(view.portfolio!.allocatedCapacityMinutes,10);assert.equal(view.cohort!.denominator,2);assert.equal((await reconcile(session,c,opts)).status,'COMMITTED');await assert.rejects(execute(session,{...c,idempotencyKey:randomUUID()},opts),{code:'VERSION_CONFLICT'});
  });
  await t.test('actual machine HTTP verifies each explicit resource grant, seals one stage effect, and keeps UNKNOWN reserved',async()=>{
   const machineActor=randomUUID(),workload=randomUUID(),taskId=randomUUID(),grantIds=[randomUUID(),randomUUID()],key=generateKeyPairSync('ed25519');
   await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role)values($1,$2,'Isolated machine','machine@example.invalid','agent','novalure_operator')",[machineActor,ws]);
   await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)values($1,$2,$3,true,true)",[ws,project,machineActor]);
   // Privileged fixture provisioning only; the protected registration API is covered by its unchanged native suite.
   await db.admin.query(`insert into crm_website_sales_machine_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,authority_reference)values($1,'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC local fixture only')`,[workload,ws,machineActor,CRM_MACHINE_ISSUER,CRM_MACHINE_AUDIENCE,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_OWNER_ID,CRM_MACHINE_SUBJECT,CRM_MACHINE_ENVIRONMENT]);
   for(let i=0;i<2;i++)await db.admin.query(`insert into crm_website_sales_machine_grants(id,workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,not_before) values($1,$2,$3,$4,$5,$6,$7,'SALES','evelyn.sales.website-1',$8,'SYNTHETIC local fixture only',$9,$10,clock_timestamp())`,[grantIds[i],workload,ws,machineActor,project,companies[i],scopes[i].locationId,taskId,key.publicKey.export({format:'der',type:'spki'}).toString('base64url'),websiteSalesMachineScopes.filter(x=>x!=='crm.website-sales.register-location')]);
   const call=async(body:Record<string,unknown>,i=0)=>{const seconds=Math.floor(Date.now()/1000),payload=Buffer.from(JSON.stringify({issuedAt:seconds,expiresAt:seconds+120,nonce:randomUUID(),requestHash:crmPayloadDigest(body)})).toString('base64url'),signature=sign(null,Buffer.from(`${websiteSalesMachineDelegationDomain}.${grantIds[i]}.${payload}`),key.privateKey).toString('base64url');
    const response=await handleWebsiteSalesMachine(new Request('https://crm.example.invalid'+websiteSalesMachinePath,{method:'POST',headers:{authorization:'Bearer eyJ'+('a'.repeat(20))+'.'+('b'.repeat(24))+'.'+('c'.repeat(24)),'content-type':'application/json','x-evelyn-delegation':`v1.${grantIds[i]}.${payload}.${signature}`},body:JSON.stringify(body)}),{...opts,machineAuth:{env:{CRM_MACHINE_AUTH_ENABLED:'1',VERCEL_ENV:'production',NODE_ENV:'production'},verifier:async()=>({payload:{aud:CRM_MACHINE_AUDIENCE,iss:CRM_MACHINE_ISSUER,sub:CRM_MACHINE_SUBJECT,project_id:CRM_MACHINE_PROJECT_ID,owner_id:CRM_MACHINE_OWNER_ID,environment:CRM_MACHINE_ENVIRONMENT,iat:seconds-5,nbf:seconds-5,exp:seconds+3600,jti:randomUUID()},protectedHeader:{alg:'RS256',typ:'JWT',kid:'isolated-synthetic-verifier'}})}});return{status:response.status,body:await response.json()};};
   const refs=[{companyId:companies[1],locationId:scopes[1].locationId,grantId:grantIds[1]}],request={...scopes[0],correlationId:randomUUID()},envelope=(request:unknown,operation='execute',target='autonomy')=>({contractVersion:websiteSalesMachineContract,target,operation,request});
   assert.equal((await call(envelope(request,'read'))).status,403);
   const readResult=await call(envelope({...request,resourceGrants:refs},'read'));assert.equal(readResult.status,200,JSON.stringify(readResult.body));assert.equal(readResult.body.data.cohort.denominator,2);
   const tampered=await call(envelope({...request,resourceGrants:[{...refs[0],companyId:companies[0]}]},'read'));assert.equal(tampered.status,403);
   const a=(await read(session,scopes[0],opts)).allocations.find(x=>x.id===allocationId)!;const i=companies.indexOf(a.companyId),w=flows[i];
   const investment={estimatedCostMinor:30,availableBudgetMinor:30,expectedNetPriceMinor:10000,estimatedDeliveryCostMinor:1000,minimumMarginBasisPoints:3000,requiredCapacityMinutes:10,availableCapacityMinutes:10,rightsVerified:true,budgetReference:`crm-allocation:${a.id}:${a.version}`};
   const stage={contractVersion:'website-sales-studio-api-v1',operation:'create_diagnosis',...scopes[i],workflowId:w.id,expectedWorkflowVersion:w.version,expectedEvidenceDigest:w.evidenceDigest,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{version:1,previousArtifactDigest:null,recommendations:[{text:'Isolated canonical business fact',evidenceIds:['business_need']}],scope:{included:['Internal website diagnosis'],excluded:['Sending, publishing and payments']},investmentPlan:investment}};
   // The earlier quote may have advanced resource 0. Refresh the owner's exact vector to a new plan is deliberately required.
   const originalVersion=(a.decision.expectedBinding as {workflowVersion:number}).workflowVersion;assert.equal(originalVersion,w.version,JSON.stringify({expected:a.decision.expectedBinding,w}));
   if(w.version!==originalVersion){stage.expectedWorkflowVersion=originalVersion;}
   const badStage={...stage,payload:{...stage.payload,investmentPlan:{...investment,estimatedCostMinor:0}}};const badClaim=await call(envelope(command('claim_allocation',{allocationId:a.id,expectedAllocationVersion:a.version,stageCommand:{target:'studio',request:badStage},resourceGrants:[{companyId:companies[1-i],locationId:scopes[1-i].locationId,grantId:grantIds[1-i]}]},a.version,i)),i);assert.equal(badClaim.status,409);assert.equal(badClaim.body.code,'SEALED_STAGE_COST_BINDING_DENIED');
   const claimRequest=command('claim_allocation',{allocationId:a.id,expectedAllocationVersion:a.version,stageCommand:{target:'studio',request:stage}},a.version,i),claimResponse=await call(envelope(claimRequest),i);
   if(w.version!==originalVersion){assert.equal(claimResponse.status,409);return;}
   assert.equal(claimResponse.status,200,JSON.stringify(claimResponse.body));const proof=claimResponse.body.data.allocationProof;
   const noProof=await call(envelope(stage,'execute','studio'),i);assert.equal(noProof.status,409);assert.equal(noProof.body.code,'SALES_ALLOCATION_REQUIRED');
   const withProof={...stage,allocationProof:proof},first=await call(envelope(withProof,'execute','studio'),i);assert.equal(first.status,200,JSON.stringify(first.body));
   const replay=await call(envelope(withProof,'execute','studio'),i);assert.equal(replay.status,200);assert.equal(replay.body.commandId,first.body.commandId);
   const settled=await call(envelope(command('settle_allocation',{allocationId:a.id,expectedAllocationVersion:proof.version,receiptCommandId:first.body.commandId},proof.version,i)),i);assert.equal(settled.status,200,JSON.stringify(settled.body));
   assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_ops_effects where allocation_id=$1',[a.id])).rows[0].n,1);
   const historical=await call(envelope({...request,resourceGrants:refs},'read'));assert.equal(historical.status,200);
   await db.admin.query('update crm_website_sales_machine_grants set revoked_at=clock_timestamp() where id=$1',[grantIds[1-i]]);assert.equal((await call(envelope({...request,resourceGrants:refs},'read'))).status,403);const ownRead=await call(envelope({...scopes[i],view:'resource',correlationId:randomUUID()},'read'),i);assert.equal(ownRead.status,200,JSON.stringify(ownRead.body));assert.equal(ownRead.body.data.cohort,null);assert.equal(ownRead.body.data.projection,'RESOURCE');const recovered=await call(envelope(claimRequest,'reconcile'),i);assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.status,'COMMITTED');assert.equal(recovered.body.currentData.projection,'RESOURCE');
  });

  const content={subject:'Canonical website draft',recipientName:'Canonical buyer',recipientEmail:'buyer0@example.invalid',scope:'Bounded website diagnosis and design',paymentPlan:'Owner-reviewed payment terms',discounts:'None',specialTerms:'Draft only',riskComplianceNotes:'No send authority',terms:'Subject to final offer approval',validUntil:future,currency:'EUR',taxBasis:'NET',items:[{description:'Website project',quantity:1,unitNetCents:10000}]};
  let quoteId='',quoteDigest='',ruleId='';
  await t.test('versioned owner pricing creates and applies exact canonical DRAFT revision',async()=>{
   const draft=await irish(0,'prepare_offer',{content,expectedEvidenceDigest:flows[0].evidenceDigest},{locationId:scopes[0].locationId,expectedVersion:flows[0].version});flows[0]=draft.data.workflow!;
   const pricing={enabled:true,validFrom:past,validUntil:future,currency:'EUR',products:[{sku:'WEBSITE',unitNetPriceMinor:10000,minimumUnitNetPriceMinor:7000,maxDiscountBps:2000}],minimumMarginBps:3000,maximumNegotiationRounds:4,maxQuoteAgeMinutes:60,negotiationStepBps:500,maximumCounteroffers:2};
   ruleId=(await execute(session,command('register_price_rule',{label:'Owner website policy',policy:pricing,estimatedDeliveryCostMinor:1000}),opts)).data.ruleId!;
   const proposed=await execute(session,command('propose_price',{ruleId,ruleVersion:1,mode:'INITIAL',requestedDiscountBps:0,lines:[{sku:'WEBSITE',quantity:1}]},flows[0].version),opts);quoteId=proposed.data.quoteId!;const before=await read(session,scopes[0],opts);quoteDigest=before.quotes.find(q=>q.id===quoteId)!.quoteDigest;assert.equal(before.quotes[0].quote.netMinor,10000);
   const apply=await execute(session,command('apply_quote',{quoteId,quoteDigest,expectedQuoteVersion:1},flows[0].version),opts);flows[0]={...flows[0],version:apply.data.version};const offer=(await db.admin.query('select status,version,revision,approval_id from crm_offers where id=$1',[flows[0].offerDraftId])).rows[0];assert.equal(offer.status,'DRAFT');assert.equal(offer.revision,2);assert.equal(offer.approval_id,null);const priceFact=await withCrmRead(session,tx=>readCurrentSalesPriceFact(tx,session,scopes[0]),opts);assert.ok(priceFact);assert.equal(websiteSalesAnswerFactSchema.parse(priceFact).sourceDigest,quoteDigest);
   await assert.rejects(execute(session,command('apply_quote',{quoteId,quoteDigest,expectedQuoteVersion:1},flows[0].version),opts),{code:'VERSION_CONFLICT'});
   await assert.rejects(execute(session,command('propose_price',{ruleId,ruleVersion:1,mode:'AUTO_COUNTEROFFER',requestedDiscountBps:0,lines:[{sku:'WEBSITE',quantity:1}]},flows[0].version),opts),{code:'PRICE_OBJECTION_SOURCE_REQUIRED'});
  });
  await t.test('repricing invalidates a historical accepted scope before any handoff and preserves its append-only record',async()=>{
   const workflow=flows[0],investmentPlan={estimatedCostMinor:0,availableBudgetMinor:0,expectedNetPriceMinor:10000,estimatedDeliveryCostMinor:1000,minimumMarginBasisPoints:3000,requiredCapacityMinutes:1,availableCapacityMinutes:100,rightsVerified:true,budgetReference:null};
   const studio=(operation:string,payload:Record<string,unknown>)=>executeWebsiteSalesStudioCommand(session,{contractVersion:'website-sales-studio-api-v1',operation:operation as 'create_diagnosis',...scopes[0],workflowId:workflow.id,expectedWorkflowVersion:workflow.version,expectedEvidenceDigest:workflow.evidenceDigest,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload},opts);
   const claim={text:'Isolated canonical business fact',evidenceIds:['business_need']},scope={included:['Website concept'],excluded:['Publication, sending and payments']};
   let diagnosis=(await db.admin.query("select artifact_digest from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and kind='DIAGNOSIS' order by version desc limit 1",[ws,workflow.id])).rows[0]?.artifact_digest as string|undefined;
   if(!diagnosis)diagnosis=(await studio('create_diagnosis',{version:1,previousArtifactDigest:null,recommendations:[claim],scope,investmentPlan})).data.artifactDigest as string;
   const concept=await studio('create_concept',{version:1,previousArtifactDigest:null,diagnosisDigest:diagnosis,objective:'Source-bound local website concept',hero:claim,sections:[{title:'Service details',body:claim}],visualDirection:'STUDIO_BLUE',scope,investmentPlan});
   await studio('accept_concept',{artifactId:concept.data.artifactId});const demo=await studio('build_demo',{version:1,previousArtifactDigest:null,conceptDigest:concept.data.artifactDigest,investmentPlan});
   const binding=await withCrmRead(session,tx=>readSalesAcceptancePrice(tx,ws,workflow.id),opts);assert.ok(binding?.acceptedQuoteId);const acceptanceId=randomUUID();
   // An existing operator-attested acceptance is a fixture, not a claim that rendered QA or customer contact occurred.
   await db.admin.query(`insert into crm_website_sales_customer_acceptances(id,workspace_id,project_id,company_id,location_id,workflow_id,concept_artifact_id,demo_artifact_id,concept_digest,demo_digest,evidence_digest,source_reference,scope,accepted_by,acceptance_digest,version,accepted_quote_id,accepted_offer_id,accepted_offer_version,accepted_offer_revision,accepted_offer_digest)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SYNTHETIC historical scope fixture',$12::jsonb,$13,$14,1,$15,$16,$17,$18,$19)`,[acceptanceId,ws,project,companies[0],scopes[0].locationId,workflow.id,concept.data.artifactId,demo.data.artifactId,concept.data.artifactDigest,demo.data.artifactDigest,workflow.evidenceDigest,JSON.stringify({included:['Website concept'],excluded:['Publication'],acceptanceCriteria:['Local review'],prerequisites:['Licensed assets']}),actor,'c'.repeat(64),binding.acceptedQuoteId,binding.acceptedOfferId,binding.acceptedOfferVersion,binding.acceptedOfferRevision,binding.acceptedOfferDigest]);
   assert.equal((await readWebsiteSalesLifecycle(session,scopes[0],opts)).customerAcceptances[0].current,true);
   const proposed=await execute(session,command('propose_price',{ruleId,ruleVersion:1,mode:'REQUESTED_DISCOUNT',requestedDiscountBps:500,lines:[{sku:'WEBSITE',quantity:1}]},workflow.version),opts),q=(await read(session,scopes[0],opts)).quotes.find(x=>x.id===proposed.data.quoteId)!;
   const applied=await execute(session,command('apply_quote',{quoteId:q.id,quoteDigest:q.quoteDigest,expectedQuoteVersion:1},workflow.version),opts);flows[0]={...workflow,version:applied.data.version};
   assert.equal((await readWebsiteSalesLifecycle(session,scopes[0],opts)).customerAcceptances[0].current,false);
   await assert.rejects(executeWebsiteSalesLifecycleCommand(session,{contractVersion:'website-sales-lifecycle-v1',operation:'create_handoff',...scopes[0],expectedVersion:flows[0].version,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{customerAcceptanceId:acceptanceId}},opts),{code:'CURRENT_CUSTOMER_ACCEPTANCE_REQUIRED'});
   assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_customer_acceptances where id=$1',[acceptanceId])).rows[0].n,1);
  });
  await t.test('payments/costs remain recordable after opt-out; original denominator and unknown cost coverage remain truthful',async()=>{
   const stopped=await irish(0,'stop',{reason:'OPT_OUT',sourceReference:'Isolated canonical opt-out'},{locationId:scopes[0].locationId,expectedVersion:flows[0].version});flows[0]=stopped.data.workflow!;
   const source=async(kind:string,amountMinor:number|null,sourceSystem='APPROVED_MANUAL',basis='SETTLED_ACTUAL')=>{
    const body={sourceSystem,recordId:`isolated-${kind}-${randomUUID()}`,economicEventId:randomUUID(),recordVersion:1,previousSourceDigest:null,supersedesSourceId:null,kind,currency:'EUR',amountMinor,occurredAt:new Date().toISOString(),relatedSourceId:null,basis};
    const r=await execute(session,command('register_financial_evidence',body,flows[0].version),opts),saved=(await read(session,scopes[0],opts)).financialEvidence.find(x=>x.id===r.data.financialEvidenceId)!;
    const outcome=command('record_outcome',{sourceId:saved.id,canonicalSourceHash:saved.canonicalSourceHash},flows[0].version);const effect=await execute(session,outcome,opts);assert.equal((await execute(session,outcome,opts)).commandId,effect.commandId);return saved;
   };
   await source('PAYMENT',10000,'BANK');await source('COST',12000,'ACCOUNTING');
   assert.equal(((await read(session,scopes[0],opts)).cohort!.results as {realizedProfitMinor:number|null}[]).every(x=>x.realizedProfitMinor===null),true);
   await source('FULFILLED',null,'CRM','CRM_OBSERVATION');await source('PAYMENTS_COMPLETE',null);await source('COSTS_COMPLETE',null);
   const report=(await read(session,scopes[0],opts)).cohort!;assert.equal(report.denominator,2);assert.equal(report.completedProfitSamples,1);assert.equal((report.results as {realizedProfitMinor:number|null}[]).find(x=>x.realizedProfitMinor!==null)!.realizedProfitMinor,-2000);assert.equal((report.conversion as {closedWonCount:number}).closedWonCount,0);assert.equal(report.profitPrediction,null);
   await assert.rejects(execute(session,command('record_outcome',{sourceId:randomUUID(),canonicalSourceHash:'a'.repeat(64)},flows[0].version),opts),{code:'CANONICAL_FINANCIAL_SOURCE_REQUIRED'});
  });
  await t.test('actual-loss recommendation creates only an exact human-reviewed bounded policy; no self promotion',async()=>{
   const view=await read(session,scopes[0],opts);portfolioVersion=view.portfolio!.version;
   const improvementRule={enabled:true,validFrom:past,validUntil:future,minimumCompletedSamples:1,minimumCoverageBps:5000,permittedField:'MIN_MARGIN_BPS',currentValue:3000,minimumValue:2000,maximumValue:6000,maximumAbsoluteChange:500};
   const configured=await execute(session,command('configure_portfolio',{title:'Reviewed learning window',policy:portfolioRule,budgetMinor:50,capacityMinutes:15,windowStart:past,windowEnd:future,managedResources:scopes,stageEstimates:[{stage:'DIAGNOSIS',estimatedCostMinor:30,requiredMinutes:10}],improvementRule,improvementTargetRuleId:ruleId},portfolioVersion),opts);portfolioVersion=configured.data.version;
   const improvementPolicy=(await read(session,scopes[0],opts)).policies.find(x=>x.kind==='IMPROVEMENT')!;
   const proposalCommand=command('propose_improvement',{ruleId:improvementPolicy.id},portfolioVersion),proposed=await execute(session,proposalCommand,opts);const candidate=(await read(session,scopes[0],opts)).improvements.find(x=>x.id===proposed.data.improvementId)!;
   const own=await read(session,scopes[0],opts,true);assert.equal(own.projection,'RESOURCE');assert.deepEqual(own.improvements,[]);assert.equal(own.cohort,null);assert(!JSON.stringify(own).includes('observedRealizedProfitMinor'));
   assert.deepEqual(proposed.currentData.improvements,[]);const replayed=await reconcile(session,proposalCommand,opts);assert.equal(replayed.status,'COMMITTED');if(replayed.status==='COMMITTED')assert.deepEqual(replayed.currentData.improvements,[]);
   assert.equal((candidate.candidate.proposal as {proposedValue:number}).proposedValue,3500);
   await assert.rejects(execute(session,command('promote_improvement',{improvementId:candidate.id,candidateDigest:candidate.candidateDigest,decisionId:randomUUID()},portfolioVersion),opts),{code:'CURRENT_HUMAN_PROMOTION_APPROVAL_REQUIRED'});
   const reviewed=await execute(session,command('review_improvement',{improvementId:candidate.id,candidateDigest:candidate.candidateDigest,decision:'APPROVED',validUntil:new Date(Date.now()+600000).toISOString()},portfolioVersion),opts);
   const promoted=await execute(session,command('promote_improvement',{improvementId:candidate.id,candidateDigest:candidate.candidateDigest,decisionId:reviewed.data.decisionId},portfolioVersion),opts);assert.ok(promoted.data.policyId);const current=(await read(session,scopes[0],opts)).policies.find(x=>x.id===promoted.data.policyId)!;assert.equal(current.policy.minimumMarginBps,3500);assert.equal(current.active,true);assert.equal((await read(session,scopes[0],opts)).policies.find(x=>x.id===ruleId)!.active,false);
  });
  await t.test('improvement authority cannot cross a project through a foreign pricing policy group',async()=>{
   const foreignProject=randomUUID(),foreignId=randomUUID();await db.admin.query("insert into projects(id,workspace_id,name,type,division)values($1,$2,'Other scoped portfolio','Website','WEB_DESIGN')",[foreignProject,ws]);
   const original=(await read(session,scopes[0],opts)).policies.find(x=>x.kind==='PRICING')!,policy:Record<string,unknown>&{approval:unknown}={...original.policy,approval:original.policy.approval,policyId:foreignId,scope:{workspaceId:ws,projectId:foreignProject},revision:{version:1,previousDigest:null}};const digest=websiteSalesPolicyDigest(policy as {approval:unknown});policy.approval={...(policy.approval as Record<string,unknown>),contentDigest:digest};
   await db.admin.query(`insert into crm_website_sales_ops_policies(id,workspace_id,project_id,policy_group_id,kind,label,version,policy,policy_digest,created_by)values($1,$2,$3,$1,'PRICING','Foreign project rule',1,$4::jsonb,$5,$6)`,[foreignId,ws,foreignProject,JSON.stringify(policy),digest,actor]);await db.admin.query('insert into crm_website_sales_ops_activations(id,workspace_id,project_id,policy_id,created_by)values($1,$2,$3,$4,$5)',[randomUUID(),ws,foreignProject,foreignId,actor]);
   const view=await read(session,scopes[0],opts);await assert.rejects(execute(session,command('configure_portfolio',{title:'Forbidden cross-project target',policy:portfolioRule,budgetMinor:50,capacityMinutes:15,windowStart:past,windowEnd:future,managedResources:[],improvementRule:{enabled:true,validFrom:past,validUntil:future,minimumCompletedSamples:1,minimumCoverageBps:5000,permittedField:'MIN_MARGIN_BPS',currentValue:3000,minimumValue:2000,maximumValue:6000,maximumAbsoluteChange:500},improvementTargetRuleId:foreignId},view.portfolio!.version),opts),{code:'CURRENT_POLICY_REQUIRED'});
  });
  await t.test('owner can release only expired no-effect UNKNOWN; a committed stage receipt is never released',async()=>{
   const a=(await read(session,scopes[0],opts)).allocations.find(x=>x.id===allocationId)!;const original=(await db.admin.query('select * from crm_website_sales_ops_allocations where id=$1',[a.id])).rows[0];
   const make=async(stageKey:string,key:string=randomUUID())=>{const id=randomUUID(),sealed={...original.sealed_command,request:{...original.sealed_command.request,idempotencyKey:key}};await db.admin.query(`insert into crm_website_sales_ops_allocations(id,workspace_id,project_id,company_id,location_id,workflow_id,portfolio_id,assignment_id,stage,amount_minor,capacity_minutes,status,version,expires_at,lease_token,claimed_by,sealed_command,sealed_digest,stage_operation_id,decision,created_by)values($1,$2,$3,$4,$5,$6,$7,$8,$9,0,1,'CLAIMED',2,clock_timestamp()-interval '1 minute',$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16)`,[id,ws,project,a.companyId,a.locationId,a.workflowId,a.portfolioId,a.assignmentId,stageKey,randomUUID(),original.claimed_by,JSON.stringify(sealed),crmPayloadDigest(sealed),key,JSON.stringify(original.decision),actor]);return{id,key};};
   const unknown=await make('CONCEPT'),i=companies.indexOf(a.companyId);const released=await execute(session,command('settle_allocation',{allocationId:unknown.id,expectedAllocationVersion:2,outcome:'RELEASED'},2,i),opts);assert.equal(released.data.version,3);assert.equal((await db.admin.query('select status from crm_website_sales_ops_allocations where id=$1',[unknown.id])).rows[0].status,'RELEASED');
   const protectedRow=await make('DEMO',original.stage_operation_id);
   await assert.rejects(execute(session,command('settle_allocation',{allocationId:protectedRow.id,expectedAllocationVersion:2,outcome:'RELEASED'},2,i),opts),{code:'COMMITTED_STAGE_MUST_SETTLE'});
  });
  await t.test('price proposal/application and human evidence refresh share canonical lock order and stale CAS has zero effects',async()=>{
   const pricingRule=(await read(session,scopes[1],opts)).policies.find(p=>p.kind==='PRICING'&&p.active)!;
   const setup=async()=>{
    const registered=await irish(1,'register_location',{countryCode:'IE',address:`${randomUUID()} Atomicity Street, Dublin, Ireland`,sourceUrl:'https://example.invalid/atomic-location',sourceReference:'Isolated canonical atomicity fixture'}),scope={...scopes[1],locationId:registered.data.location.id};
    const original=(await db.admin.query('select prospect from crm_website_sales_observations where workspace_id=$1 and company_id=$2 order by observed_at desc limit 1',[ws,companies[1]])).rows[0].prospect as import('../src/lib/website-prospect').WebsiteProspectInput;
    const prospect=structuredClone(original);prospect.identity={workspaceId:ws,...scope};prospect.evidence=prospect.evidence.map(e=>({...e,identity:prospect.identity,observedAt:past,validUntil:future}));
    const observed=await irish(1,'observe',{prospect,investmentPlan:plan},{locationId:scope.locationId,locationVersion:1}),qualified=await irish(1,'qualify',{contactId:contacts[1],opportunitySummary:'Atomic canonical pricing opportunity',nextAction:'Internal review',expectedEvidenceDigest:observed.data.workflow!.evidenceDigest},{locationId:scope.locationId,expectedVersion:observed.data.workflow!.version});
    const draft=await irish(1,'prepare_offer',{content:{...content,recipientEmail:'buyer1@example.invalid'},expectedEvidenceDigest:qualified.data.workflow!.evidenceDigest},{locationId:scope.locationId,expectedVersion:qualified.data.workflow!.version}),workflow=draft.data.workflow!;
    const price=(operation:SalesOperationsCommand['operation'],payload:Record<string,unknown>)=>({...command(operation,payload,workflow.version,1),...scope});
    const proposed=await execute(session,price('propose_price',{ruleId:pricingRule.id,ruleVersion:pricingRule.version,mode:'INITIAL',requestedDiscountBps:0,lines:[{sku:'WEBSITE',quantity:1}]}),opts),quote=(await read(session,scope,opts,true)).quotes.find(q=>q.id===proposed.data.quoteId)!;
    const newer=structuredClone(prospect);newer.evidence=newer.evidence.map(e=>({...e,observedAt:new Date(Date.now()-1).toISOString(),finding:e.finding+' Updated isolated fact.'}));
    const refresh={contractVersion:'website-sales-lifecycle-v1' as const,operation:'refresh_evidence' as const,...scope,expectedVersion:workflow.version,idempotencyKey:randomUUID(),correlationId:randomUUID(),payload:{prospect:newer,locationVersion:1}};
    return{scope,workflow,quote,price,refresh};
   };
   const deadline=<T>(promise:Promise<T>,label:string)=>Promise.race([promise,new Promise<never>((_resolve,reject)=>{const timer=setTimeout(()=>reject(Error(label)),5000);timer.unref();})]);
   for(const winner of ['refresh','apply','refresh-proposal'] as const){
    const data=await setup(),priceOperation=winner==='refresh-proposal'?'propose_price':'apply_quote',priceCommand=data.price(priceOperation,priceOperation==='apply_quote'?{quoteId:data.quote.id,quoteDigest:data.quote.quoteDigest,expectedQuoteVersion:1}:{ruleId:pricingRule.id,ruleVersion:pricingRule.version,mode:'REQUESTED_DISCOUNT',requestedDiscountBps:500,lines:[{sku:'WEBSITE',quantity:1}]});
    let held!:()=>void,release!:()=>void,first!: (kind:string)=>void,legacyUpdate!:()=>void,loserPid=0,casUpdate=false;
    const heldPromise=new Promise<void>(resolve=>{held=resolve;}),releasePromise=new Promise<void>(resolve=>{release=resolve;}),firstPromise=new Promise<string>(resolve=>{first=resolve;}),legacyUpdatePromise=new Promise<void>(resolve=>{legacyUpdate=resolve;});
    const winnerRole=winner==='apply'?'price':'refresh',loserRole=winnerRole==='price'?'refresh':'price';
    const controlledPool=(role:'price'|'refresh')=>({connect:async()=>{
     const connection=await db.pool.connect();if(role===loserRole)loserPid=Number((await connection.query('select pg_backend_pid() as pid')).rows[0].pid);
     return{release:connection.release.bind(connection),query:(...args:unknown[])=>{
      const sql=typeof args[0]==='string'?args[0]:'',params=Array.isArray(args[1])?args[1]:[],locationLock=sql.includes('pg_advisory_xact_lock')&&String(params[0]).startsWith('website-sales-location:');
      if(role===loserRole){if(locationLock)first('location');else if(sql.includes('crm_website_sales_ops_quotes')&&sql.includes('for update'))first('quote');else if(sql.includes('crm_offers')&&sql.includes('for update'))first('offer');if(sql.startsWith('update crm_website_sales_workflows'))legacyUpdate();}
      if(role==='price'&&sql.startsWith('update crm_website_sales_workflows'))casUpdate=/and version=\$4 returning id/.test(sql)&&params[3]===data.workflow.version;
      const result:unknown=Reflect.apply(connection.query,connection,args);
      if(role===winnerRole&&sql.includes('from crm_website_sales_workflows w join crm_website_sales_observations')&&sql.includes('for update of w')&&result instanceof Promise)return result.then(async value=>{held();await releasePromise;return value;});
      return result;
     }};
    }}) as unknown as TenantPool;
    const priceOptions={pool:controlledPool('price')},refreshOptions={pool:controlledPool('refresh')};
    const runPrice=()=>execute(session,priceCommand,priceOptions).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})),runRefresh=()=>executeWebsiteSalesLifecycleCommand(session,data.refresh,refreshOptions).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
    const firstRun=winnerRole==='price'?runPrice():runRefresh();let secondRun:ReturnType<typeof runPrice>|ReturnType<typeof runRefresh>|undefined;
    try{
     await deadline(heldPromise,'Winning operation did not acquire the actual workflow row lock');secondRun=loserRole==='price'?runPrice():runRefresh();
     const firstLock=await deadline(firstPromise,'Losing operation did not attempt a business lock');
     if(firstLock!=='location')await deadline(legacyUpdatePromise,'Legacy offer-before-workflow path did not reach its conflicting workflow update');
     let waiting=false;const until=Date.now()+2000;while(!waiting&&Date.now()<until){waiting=(await db.admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) as waiting",[loserPid])).rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));}
     assert.equal(waiting,true,'Actual loser must wait on the held location/workflow authority');
    }finally{release();}
    const firstResult=await firstRun,secondResult=await secondRun!;if(!firstResult.ok)throw firstResult.error;assert.equal(secondResult.ok,false);if(!secondResult.ok)assert.equal((secondResult.error as {code:string}).code,'VERSION_CONFLICT');
    const current=(await db.admin.query('select version,observation_id from crm_website_sales_workflows where id=$1',[data.workflow.id])).rows[0],quote=(await db.admin.query('select status,version from crm_website_sales_ops_quotes where id=$1',[data.quote.id])).rows[0],offer=(await db.admin.query('select revision from crm_offers where id=$1',[data.workflow.offerDraftId])).rows[0];
    assert.equal(current.version,data.workflow.version+1);assert.equal(quote.status,winner==='apply'?'APPLIED':'PROPOSED');assert.equal(quote.version,winner==='apply'?2:1);assert.equal(offer.revision,winner==='apply'?2:1);
    assert.equal((await db.admin.query('select count(*)::int n from crm_command_receipts where workspace_id=$1 and idempotency_key=$2',[ws,winner==='apply'?data.refresh.idempotencyKey:priceCommand.idempotencyKey])).rows[0].n,0,'Stale operation has no persisted receipt');
    assert.equal((await db.admin.query('select count(*)::int n from crm_website_sales_ops_quotes where workflow_id=$1',[data.workflow.id])).rows[0].n,1,'Stale proposal/application cannot append another quote');
    if(winner==='apply')assert.equal(casUpdate,true,'Actual workflow mutation must enforce exact CAS and require RETURNING');
   }
  });
  await t.test('tenant isolation, actor binding and append-only source history are enforced by actual runtime RLS',async()=>{
   await assert.rejects(read({...session,workspaceId:otherWs,userId:otherActor},scopes[0],opts),{code:'PROJECT_FORBIDDEN'});
   await withCrmRead(session,async tx=>{assert.equal((await tx.query('select id from crm_website_sales_ops_portfolios where workspace_id=$1',[otherWs])).length,0);},opts);
  });

  await assert.rejects(withCrmRead(session,tx=>tx.execute('update crm_website_sales_ops_policies set label=$1',['forged']),opts),/permission denied/);
  assert.ok(allocationId&&quoteId&&quoteDigest);
 }finally{await db.stop();}
});
