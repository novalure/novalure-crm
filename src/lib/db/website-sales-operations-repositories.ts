import {recommendWebsiteSalesImprovementValue} from "../website-sales-learning";
import {readCurrentSalesConversationTopic,readSalesConversationDescriptor} from "./website-sales-conversation-source";
import {randomUUID,createHash} from "node:crypto";
import {z} from "zod";
import type {AppSession} from "../auth/session";
import {assertProjectGrant,crmPayloadDigest,CrmCommandError,executeCrmCommand,reconcileCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from "../crm-command";
import {websiteSalesActorAuthority,websiteSalesResourceAuthority,websiteSalesResourceReadScopes} from "../website-sales-machine-authority";
import {websiteSalesOperationsContract,type SalesOperationsCommand,type SalesOperationsScope,type SalesOperationsRead,type SalesOperationsEffect} from "../website-sales-operations-types";
import {portfolioPolicySchema,pricingPolicySchema,improvementRuleSchema,outcomeSourceSchema,websiteSalesOperationsDigest,websiteSalesPolicyDigest,
 type OperationsOrigin,type OperationsBinding,type PortfolioInput,type PricingInput,type OutcomeCohort} from "../website-sales-operations-contracts";
import {planWebsiteSalesPortfolio} from "../website-sales-operations-portfolio";
import {createWebsiteSalesPriceProposal,type WebsiteSalesPriceProposal} from "../website-sales-operations-pricing";
import {summarizeWebsiteSalesOutcomes,websiteSalesOutcomeSourceDigest,proposeWebsiteSalesImprovement,evaluateWebsiteSalesImprovementPromotion} from "../website-sales-operations-outcomes";
import {websiteSalesIrelandState as canonicalState} from "./website-sales-ireland-repositories";
import {executeOfferCommand} from "./offer-repositories";
import {parseOfferContent,type OfferContent} from "../offer-workflow";
import {salesAllocationProofSchema,salesStageCommand} from "../website-sales-allocation";

import {qualifyWebsiteProspect} from "../website-prospect";

const uuid=z.uuid(),hash=z.hash("sha256"),money=z.number().int().nonnegative().safe(),time=z.iso.datetime({offset:true}),text=z.string().trim().min(1).max(500);
const scopeSchema=z.strictObject({projectId:uuid,companyId:uuid,locationId:uuid});
const grantSchema=z.strictObject({companyId:uuid,locationId:uuid,grantId:uuid});
const commandSchema=scopeSchema.extend({contractVersion:z.literal(websiteSalesOperationsContract),operation:z.enum(["configure_portfolio","plan_portfolio","claim_allocation","settle_allocation","register_price_rule","propose_price","apply_quote","register_financial_evidence","record_outcome","propose_improvement","review_improvement","promote_improvement"]),expectedVersion:z.number().int().nonnegative().safe(),idempotencyKey:z.uuidv4(),correlationId:uuid,payload:z.record(z.string(),z.unknown()),allocationProof:salesAllocationProofSchema.optional()});
const candidateRef=scopeSchema.extend({workflowId:uuid,expectedWorkflowVersion:z.number().int().positive().safe(),expectedEvidenceDigest:hash,requestedStage:z.enum(["DIAGNOSIS","CONCEPT","CONCEPT_ACCEPTANCE","DEMO","CONVERSATION"]).default("DIAGNOSIS"),purpose:z.enum(["INTERNAL_RESEARCH","NEW_CUSTOMER_DIALOG"]).default("INTERNAL_RESEARCH"),dialogSourceId:uuid.nullable().default(null)});
const portfolioRaw=portfolioPolicySchema.omit({policyId:true,scope:true,revision:true,approval:true});
const priceRaw=pricingPolicySchema.omit({policyId:true,scope:true,revision:true,approval:true});
const improvementRaw=improvementRuleSchema.omit({policyId:true,scope:true,revision:true,approval:true});
const financialRaw=outcomeSourceSchema.omit({sourceId:true,origin:true,observedAt:true,sourceDigest:true,approvalReference:true,sourceConfidence:true});
const payloads={
 configure_portfolio:z.strictObject({title:text,policy:portfolioRaw,budgetMinor:money,capacityMinutes:money,windowStart:time,windowEnd:time,managedResources:z.array(scopeSchema).max(200),stageEstimates:z.array(z.strictObject({stage:z.enum(["DIAGNOSIS","CONCEPT","CONCEPT_ACCEPTANCE","DEMO","CONVERSATION"]),estimatedCostMinor:money,requiredMinutes:z.number().int().positive().safe()})).max(5).refine(rows=>new Set(rows.map(r=>r.stage)).size===rows.length&&rows.every(r=>r.stage!=="CONCEPT_ACCEPTANCE"||r.estimatedCostMinor===0&&r.requiredMinutes===1),"UNIQUE_STAGE_COSTS_AND_INTERNAL_ACCEPTANCE_REQUIRED").default([]),improvementRule:improvementRaw.optional(),improvementTargetRuleId:uuid.optional(),improvementTargetSku:text.optional()}),
 plan_portfolio:z.strictObject({portfolioId:uuid,candidates:z.array(candidateRef).min(1).max(200)}),
 claim_allocation:z.strictObject({allocationId:uuid,expectedAllocationVersion:z.number().int().positive().safe(),stageCommand:z.strictObject({target:z.enum(["workflow","studio","lifecycle","autonomy"]),request:z.record(z.string(),z.unknown())})}),
 settle_allocation:z.strictObject({allocationId:uuid,expectedAllocationVersion:z.number().int().positive().safe(),outcome:z.enum(["COMPLETED","RELEASED"]).default("COMPLETED"),receiptCommandId:uuid.optional()}),
 register_price_rule:z.strictObject({label:text,policy:priceRaw,policyGroupId:uuid.optional(),estimatedDeliveryCostMinor:money,skuLabels:z.record(text,text).optional()}),
 propose_price:z.strictObject({ruleId:uuid,ruleVersion:z.number().int().positive().safe(),mode:z.enum(["INITIAL","REQUESTED_DISCOUNT","AUTO_COUNTEROFFER"]),requestedDiscountBps:z.number().int().min(0).max(10000).default(0),lines:z.array(z.strictObject({sku:text,quantity:z.number().int().min(1).max(1000)})).min(1).max(30),dialogSourceId:uuid.optional()}),
 apply_quote:z.strictObject({quoteId:uuid,quoteDigest:hash,expectedQuoteVersion:z.number().int().positive().safe()}),
 register_financial_evidence:financialRaw,
 record_outcome:z.strictObject({sourceId:uuid,canonicalSourceHash:hash}),
 propose_improvement:z.strictObject({ruleId:uuid,proposedValue:money.optional()}),
 review_improvement:z.strictObject({improvementId:uuid,candidateDigest:hash,decision:z.enum(["APPROVED","REJECTED"]),validUntil:time}),
 promote_improvement:z.strictObject({improvementId:uuid,candidateDigest:hash,decisionId:uuid})
};
const ownerOps=new Set(["configure_portfolio","register_price_rule","register_financial_evidence","review_improvement"]);
type Json=Record<string,unknown>;
type PolicyRow={projectId:string;id:string;policyGroupId:string;version:number;kind:"PORTFOLIO"|"PRICING"|"IMPROVEMENT";label:string;policy:Json;settings:Json;policyDigest:string;createdAt:string;active:boolean};
type PortfolioRow={id:string;version:number;title:string;policyId:string;budgetMinor:number|string;capacityMinutes:number|string;windowStart:string;windowEnd:string};
function scopeOf(s:SalesOperationsScope):SalesOperationsScope{return{projectId:s.projectId,companyId:s.companyId,locationId:s.locationId};}
function websiteSalesIrelandState(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope,lock=false){return canonicalState(tx,session,scopeOf(scope),lock);}
type State=Awaited<ReturnType<typeof canonicalState>>;
type AssignmentRow={id:string;origin:OperationsOrigin;enteredAt:string;workflowId:string;projectId:string;companyId:string;locationId:string};
const pcols=`id,version,title,policy_id as "policyId",budget_minor as "budgetMinor",capacity_minutes as "capacityMinutes",window_start::text as "windowStart",window_end::text as "windowEnd"`;
const polcols=`p.project_id as "projectId",p.id,p.policy_group_id as "policyGroupId",p.version,p.kind,p.label,p.policy,p.settings,p.policy_digest as "policyDigest",p.created_at::text as "createdAt",(exists(select 1 from crm_website_sales_ops_activations a where a.workspace_id=p.workspace_id and a.policy_id=p.id) and not exists(select 1 from crm_website_sales_ops_policies newer join crm_website_sales_ops_activations activation on activation.workspace_id=newer.workspace_id and activation.policy_id=newer.id where newer.workspace_id=p.workspace_id and newer.project_id=p.project_id and newer.policy_group_id=p.policy_group_id and newer.version>p.version)) as active`;
const qcols=`id,project_id as "projectId",company_id as "companyId",location_id as "locationId",workflow_id as "workflowId",rule_id as "ruleId",rule_version as "ruleVersion",version,status,quote,quote_digest as "quoteDigest",offer_id as "offerId",offer_version as "offerVersion",offer_revision as "offerRevision",offer_digest as "offerDigest",applied_at::text as "appliedAt",created_at::text as "createdAt"`;
type QuoteRow={id:string;projectId:string;companyId:string;locationId:string;workflowId:string;ruleId:string;ruleVersion:number;version:number;status:"PROPOSED"|"APPLIED";quote:WebsiteSalesPriceProposal;quoteDigest:string;offerId:string;offerVersion:number;offerRevision:number;offerDigest:string;appliedAt:string|null;createdAt:string};
function fail(code:string,status=409):never{throw new CrmCommandError(code,code,status);}
function n(value:unknown):number{return money.parse(Number(value));}
function checkedVersion(expected:number,actual:number){if(expected!==actual)fail("VERSION_CONFLICT");}
function now(){return new Date().toISOString();}
function payload<K extends keyof typeof payloads>(c:SalesOperationsCommand,op:K):z.infer<typeof payloads[K]>{const body={...c.payload};delete body.resourceGrants;return payloads[op].parse(body) as z.infer<typeof payloads[K]>;}
function revision(version:number,body:unknown){return{version,previousDigest:version===1?null:websiteSalesOperationsDigest(body)};}
function identity(session:AppSession,scope:SalesOperationsScope){return{workspaceId:session.workspaceId,projectId:scope.projectId,companyId:scope.companyId,locationId:scope.locationId};}
async function owner(tx:TenantTransaction,session:AppSession){if(session.serviceIdentity||!(await tx.queryOne<{ok:boolean}>("select crm_sales_ops_owner($1) as ok",[session.workspaceId]))?.ok)fail("OWNER_POLICY_AUTHORITY_REQUIRED",403);}
async function guard(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope,write=false){
 websiteSalesResourceAuthority(session,scope);await assertProjectGrant(tx,session,scope.projectId,write);
 const row=await tx.queryOne(`select 1 from workspaces w join projects p on p.workspace_id=w.id join organizations o on o.workspace_id=w.id and o.project_id=p.id
  join crm_company_locations l on l.workspace_id=w.id and l.project_id=p.id and l.company_id=o.id where w.id=$1 and p.id=$2 and o.id=$3 and l.id=$4
  and w.operating_model='novalure_internal' and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales'
  and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);if(!row)fail("OPERATIONS_SCOPE_DENIED",403);
}
async function projectLock(tx:TenantTransaction,session:AppSession,projectId:string){await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`website-sales-operations:${session.workspaceId}:${projectId}`]);}
async function portfolio(tx:TenantTransaction,session:AppSession,projectId:string,lock=false){return tx.queryOne<PortfolioRow>(`select ${pcols} from crm_website_sales_ops_portfolios where workspace_id=$1 and project_id=$2${lock?" for update":""}`,[session.workspaceId,projectId]);}
async function policy(tx:TenantTransaction,session:AppSession,id:string,kind?:PolicyRow["kind"],requireActive=true,projectId?:string){
 const row=await tx.queryOne<PolicyRow>(`select ${polcols} from crm_website_sales_ops_policies p where p.workspace_id=$1 and p.id=$2`,[session.workspaceId,id]);
 if(!row||projectId&&row.projectId!==projectId||kind&&row.kind!==kind||requireActive&&!row.active)fail("CURRENT_POLICY_REQUIRED");
 const current=await tx.queryOne(`select 1 from crm_website_sales_ops_policies p join crm_website_sales_ops_activations a on a.workspace_id=p.workspace_id and a.policy_id=p.id
  where p.workspace_id=$1 and p.project_id=$4 and p.policy_group_id=$2 and p.version>$3`,[session.workspaceId,row.policyGroupId,row.version,row.projectId]);if(requireActive&&current)fail("POLICY_SUPERSEDED");
 const eligible=(await tx.queryOne<{allowed:boolean}>("select crm_lock_sales_policy_owner($1,$2) as allowed",[session.workspaceId,row.id]))?.allowed;
 if(!eligible||row.policyDigest!==websiteSalesPolicyDigest(row.policy as {approval:unknown}))fail("CURRENT_POLICY_APPROVAL_REQUIRED");return row;
}
async function state(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope,options:{allowReply?:boolean;lock?:boolean}={}){
 await guard(tx,session,scope);const s=await websiteSalesIrelandState(tx,session,scope,options.lock===true);
 if(!s.row||!s.current.workflow)fail("WORKFLOW_NOT_FOUND",404);const w=s.current.workflow;
 if(w.blockedReason&&!(options.allowReply&&w.blockedReason==="REPLY_RECEIVED")||w.qualificationStatus!=="READY")fail(w.blockedReason??"CURRENT_EVIDENCE_REQUIRED");
 if(w.status==="STOPPED"&&!(options.allowReply&&w.stopReason==="REPLY_RECEIVED"))fail("WORKFLOW_STOPPED");return s;
}
async function assignment(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope,workflowId:string,portfolioId:string,actorId:string){
 let row=await tx.queryOne<AssignmentRow>(`select id,origin,entered_at::text as "enteredAt",workflow_id as "workflowId",project_id as "projectId",company_id as "companyId",location_id as "locationId" from crm_website_sales_ops_assignments where workspace_id=$1 and portfolio_id=$2 and workflow_id=$3`,[session.workspaceId,portfolioId,workflowId]);
 if(!row){const id=randomUUID();const base={identity:identity(session,scope),opportunityId:workflowId,cohortAssignmentId:id};const origin={...base,attributionDigest:websiteSalesOperationsDigest(base)};
  await tx.execute(`insert into crm_website_sales_ops_assignments(id,workspace_id,project_id,company_id,location_id,workflow_id,portfolio_id,origin,attribution_digest,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[id,session.workspaceId,scope.projectId,scope.companyId,scope.locationId,workflowId,portfolioId,JSON.stringify(origin),origin.attributionDigest,actorId]);
  row={id,origin,enteredAt:now(),workflowId,...scopeOf(scope)};}return row;
}
function bind(s:State,a:AssignmentRow):OperationsBinding{const w=s.current.workflow!;return{...a.origin,workflowId:w.id,workflowVersion:w.version,recordVersion:w.version,evidenceDigest:w.evidenceDigest,
 observedAt:new Date(Math.max(...qualifyWebsiteProspect(s.row!.prospect,now()).input.evidence.map(x=>Date.parse(x.observedAt)))).toISOString(),validUntil:w.validUntil};}
async function approvedPolicy(tx:TenantTransaction,session:AppSession,projectId:string,kind:PolicyRow["kind"],label:string,raw:Json,commandId:string,groupId?:string,activate=true,settings:Json={}){
 const id=randomUUID(),group=groupId??id;const previous=await tx.queryOne<{version:number;policyDigest:string;projectId:string;kind:string}>(`select project_id as "projectId",kind,version,policy_digest as "policyDigest" from crm_website_sales_ops_policies where workspace_id=$1 and policy_group_id=$2 order by version desc limit 1`,[session.workspaceId,group]);
 if(previous&&(previous.projectId!==projectId||previous.kind!==kind))fail("POLICY_GROUP_SCOPE_DENIED",403);const version=(previous?.version??0)+1;const unsigned={...raw,policyId:group,scope:{workspaceId:session.workspaceId,projectId},revision:{version,previousDigest:previous?.policyDigest??null},approval:null};
 const digest=websiteSalesPolicyDigest(unsigned);const full={...unsigned,approval:{approvalId:commandId,approvedBy:session.userId,approvedAt:now(),validUntil:raw.validUntil,contentDigest:digest}};
 const normalized=(kind==="PORTFOLIO"?portfolioPolicySchema:kind==="PRICING"?pricingPolicySchema:improvementRuleSchema).parse(full);
 await tx.execute(`insert into crm_website_sales_ops_policies(id,workspace_id,project_id,policy_group_id,kind,label,version,policy,policy_digest,created_by,settings) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)`,[id,session.workspaceId,projectId,group,kind,label,version,JSON.stringify(normalized),digest,session.userId,JSON.stringify(settings)]);
 if(activate)await tx.execute("insert into crm_website_sales_ops_activations(id,workspace_id,project_id,policy_id,created_by) values($1,$2,$3,$4,$5)",[randomUUID(),session.workspaceId,projectId,id,session.userId]);return{id,version,policy:normalized,digest};
}
export function parseSalesOperationsCommand(raw:unknown):SalesOperationsCommand{const c=commandSchema.parse(raw);payloads[c.operation].extend({resourceGrants:z.array(grantSchema).max(199).optional()}).parse(c.payload);return c;}
export function salesOperationsCommandInput(session:AppSession,raw:SalesOperationsCommand){const c=parseSalesOperationsCommand(raw),attribution=websiteSalesActorAuthority(session,c,c.operation,"autonomy");
 if(session.serviceIdentity&&ownerOps.has(c.operation))fail("HUMAN_POLICY_AUTHORITY_REQUIRED",403);
 return{operation:`website_sales.autonomy.${c.operation}`,projectId:c.projectId,resourceId:c.locationId,idempotencyKey:c.idempotencyKey,correlationId:c.correlationId,capability:"pipeline:write" as const,payload:{request:c,machineAuthority:attribution}};
}

async function offers(tx:TenantTransaction,session:AppSession,workflow:State["current"]["workflow"]){
 if(!workflow?.offerDraftId)fail("CANONICAL_OFFER_DRAFT_REQUIRED");
 const row=await tx.queryOne<{id:string;version:number;revision:number;status:string;contentDigest:string;content:OfferContent}>(`select o.id,o.version,o.revision,o.status,r.content_digest as "contentDigest",r.content from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where o.workspace_id=$1 and o.id=$2 and o.deal_id=$3`,[session.workspaceId,workflow.offerDraftId,workflow.dealId]);
 if(!row)fail("CANONICAL_OFFER_DRAFT_REQUIRED");return row;
}
const scopeDigest=(c:OfferContent)=>crmPayloadDigest({scope:c.scope,paymentPlan:c.paymentPlan,specialTerms:c.specialTerms,currency:c.currency,taxBasis:c.taxBasis});
/** Authoritative price fact for the conversation module; caller-supplied amounts are never used. */
export async function readCurrentSalesQuoteBinding(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope){
 const s=await websiteSalesIrelandState(tx,session,scope);if(!s.current.workflow||s.current.workflow.blockedReason&&s.current.workflow.blockedReason!=="REPLY_RECEIVED")return null;
 const q=await tx.queryOne<QuoteRow>(`select ${qcols} from crm_website_sales_ops_quotes where workspace_id=$1 and workflow_id=$2 and status='APPLIED' order by applied_at desc,id desc limit 1`,[session.workspaceId,s.row!.id]);
 if(!q)return null;await guard(tx,session,scope);const offer=await offers(tx,session,s.current.workflow);
 if(q.offerVersion!==offer.version||q.offerRevision!==offer.revision||q.offerDigest!==offer.contentDigest||q.quote.binding.evidenceDigest!==s.current.workflow.evidenceDigest||Date.parse(q.quote.validUntil)<=Date.now())return null;
 try{await policy(tx,session,q.ruleId,"PRICING",true,scope.projectId);}catch{return null;}
 return{quoteId:q.id,identity:identity(session,scope),version:q.version,digest:q.quoteDigest,offerId:offer.id,offerVersion:offer.version,scopeDigest:scopeDigest(offer.content),netPriceMinor:q.quote.netMinor,currency:"EUR" as const,validUntil:q.quote.validUntil};
}
export async function readCurrentSalesPriceFact(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope){
 const quote=await readCurrentSalesQuoteBinding(tx,session,scope);if(!quote)return null;
 const row=await tx.queryOne<QuoteRow>(`select ${qcols} from crm_website_sales_ops_quotes where workspace_id=$1 and id=$2`,[session.workspaceId,quote.quoteId]);if(!row)return null;
 const rule=await policy(tx,session,row.ruleId,"PRICING",true,scope.projectId),approval=rule.policy.approval as {approvedBy:string;approvedAt:string};
 return{id:quote.quoteId,identity:quote.identity,version:quote.version,topicCode:"PRICE" as const,kind:"PRICE_QUOTE" as const,
  text:`Non-binding draft net price: EUR ${BigInt(quote.netPriceMinor)/BigInt(100)}.${(BigInt(quote.netPriceMinor)%BigInt(100)).toString().padStart(2,"0")}. Final offer approval remains required.`,sourceReference:`crm-quote:${quote.quoteId}:v${quote.version}`,
  sourceDigest:quote.digest,observedAt:new Date(row.appliedAt!).toISOString(),validUntil:quote.validUntil,approvedBy:approval.approvedBy,approvedAt:approval.approvedAt,classification:"APPROVED_SALES" as const};
}

async function cohort(tx:TenantTransaction,session:AppSession,projectId:string,version:number,resource?:SalesOperationsScope):Promise<OutcomeCohort|null>{
 const assignments=await tx.query<AssignmentRow>(`select id,origin,entered_at::text as "enteredAt",workflow_id as "workflowId",project_id as "projectId",company_id as "companyId",location_id as "locationId" from crm_website_sales_ops_assignments where workspace_id=$1 and project_id=$2${resource?" and company_id=$3 and location_id=$4":""} order by entered_at,id limit 501`,[session.workspaceId,projectId,...(resource?[resource.companyId,resource.locationId]:[])]);
 if(!assignments.length)return null;if(assignments.length>500)fail("COHORT_WINDOW_LIMIT_REQUIRED");
 for(const a of assignments)await guard(tx,session,a);
 const events=await tx.query<{id:string;event:{eventId:string;source:z.infer<typeof outcomeSourceSchema>}}>(`select id,event from crm_website_sales_ops_outcomes where workspace_id=$1 and project_id=$2${resource?" and company_id=$3 and location_id=$4":""} order by created_at,id limit 5001`,[session.workspaceId,projectId,...(resource?[resource.companyId,resource.locationId]:[])]);
 if(events.length>5000)fail("COHORT_EVENT_WINDOW_LIMIT_REQUIRED");
 return{scope:{workspaceId:session.workspaceId,projectId},revision:revision(version,{assignments,events}),origins:assignments.map(a=>({...a.origin,enteredAt:new Date(a.enteredAt).toISOString()})),events:events.map(e=>e.event)};
}
async function capacity(tx:TenantTransaction,session:AppSession,p:PortfolioRow){
 const used=await tx.queryOne<{budget:string;minutes:string}>(`select coalesce(sum(amount_minor),0)::text as budget,coalesce(sum(capacity_minutes),0)::text as minutes from crm_website_sales_ops_allocations where workspace_id=$1 and portfolio_id=$2 and created_at >= $3::timestamptz and status<>'RELEASED'`,[session.workspaceId,p.id,p.windowStart]);
 return{budget:n(used?.budget??0),minutes:n(used?.minutes??0)};
}
async function configure(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,commandId:string):Promise<Omit<SalesOperationsEffect,"workspaceId"|"projectId"|"companyId"|"locationId">>{
 await owner(tx,session);const p=payload(c,"configure_portfolio"),old=await portfolio(tx,session,c.projectId,true);checkedVersion(c.expectedVersion,old?.version??0);
 if(Date.parse(p.windowStart)>Date.now()||Date.parse(p.windowEnd)<=Date.now()||Date.parse(p.windowEnd)<=Date.parse(p.windowStart))fail("CURRENT_RESOURCE_WINDOW_REQUIRED");
 if(old&&await tx.queryOne("select 1 from crm_website_sales_ops_allocations where workspace_id=$1 and portfolio_id=$2 and status in('RESERVED','CLAIMED')",[session.workspaceId,old.id]))fail("ACTIVE_ALLOCATIONS_REQUIRE_SETTLEMENT");
 const group=old?(await policy(tx,session,old.policyId,"PORTFOLIO",false,c.projectId)).policyGroupId:undefined;
 const current=await approvedPolicy(tx,session,c.projectId,"PORTFOLIO",p.title,p.policy as Json,commandId,group,true,{stageEstimates:p.stageEstimates});
 const id=old?.id??randomUUID(),version=(old?.version??0)+1;
 if(old)await tx.execute(`update crm_website_sales_ops_portfolios set title=$3,policy_id=$4,budget_minor=$5,capacity_minutes=$6,window_start=$7,window_end=$8,version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,[session.workspaceId,id,p.title,current.id,p.budgetMinor,p.capacityMinutes,p.windowStart,p.windowEnd]);
 else await tx.execute(`insert into crm_website_sales_ops_portfolios(id,workspace_id,project_id,title,policy_id,budget_minor,capacity_minutes,window_start,window_end,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,session.workspaceId,c.projectId,p.title,current.id,p.budgetMinor,p.capacityMinutes,p.windowStart,p.windowEnd,session.userId]);
 for(const resource of p.managedResources){if(resource.projectId!==c.projectId)fail("RESOURCE_PROJECT_MISMATCH",403);await guard(tx,session,resource,true);const s=await websiteSalesIrelandState(tx,session,resource);if(!s.row)fail("WORKFLOW_NOT_FOUND",404);
  await tx.execute(`insert into crm_website_sales_ops_resource_controls(workspace_id,project_id,company_id,location_id,workflow_id,portfolio_id,created_by) values($1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id,project_id,company_id,location_id) do nothing`,[session.workspaceId,resource.projectId,resource.companyId,resource.locationId,s.row.id,id,session.userId]);
 }
 if(p.improvementRule){if(!p.improvementTargetRuleId)fail("IMPROVEMENT_TARGET_REQUIRED",400);const target=await policy(tx,session,p.improvementTargetRuleId,undefined,true,c.projectId);if(target.kind!==(p.improvementRule.permittedField==="MAX_OPPORTUNITY_COST_MINOR"?"PORTFOLIO":"PRICING"))fail("IMPROVEMENT_TARGET_KIND_DENIED",400);
  await approvedPolicy(tx,session,c.projectId,"IMPROVEMENT",`${p.title}: reviewed improvements`,p.improvementRule as Json,commandId,undefined,true,{targetPolicyId:p.improvementTargetRuleId,targetSku:p.improvementTargetSku??null});}
 return{portfolioId:id,policyId:current.id,version,canContact:false};
}
async function plan(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand):Promise<Omit<SalesOperationsEffect,"workspaceId"|"projectId"|"companyId"|"locationId">&{plan:unknown}>{
 const p=payload(c,"plan_portfolio"),bucket=await portfolio(tx,session,c.projectId,true);if(!bucket||bucket.id!==p.portfolioId)fail("PORTFOLIO_NOT_FOUND",404);checkedVersion(c.expectedVersion,bucket.version);
 if(Date.parse(bucket.windowStart)>Date.now()||Date.parse(bucket.windowEnd)<=Date.now())fail("CURRENT_RESOURCE_WINDOW_REQUIRED");
 const rule=await policy(tx,session,bucket.policyId,"PORTFOLIO",true,c.projectId),candidates:PortfolioInput["candidates"]=[],assignments=new Map<string,AssignmentRow>(),dialogSourceHashes=new Map<string,string>();
 // Stable workflow locks make the CAS vector canonical while all project allocations share the project lock.
 for(const ref of [...p.candidates].sort((a,b)=>a.workflowId.localeCompare(b.workflowId))){if(ref.projectId!==c.projectId)fail("RESOURCE_PROJECT_MISMATCH",403);await guard(tx,session,ref,true);
  await tx.query("select id from crm_website_sales_workflows where workspace_id=$1 and id=$2 for update",[session.workspaceId,ref.workflowId]);
  const s=await websiteSalesIrelandState(tx,session,ref),w=s.current.workflow;if(!s.row||!w||w.id!==ref.workflowId)fail("WORKFLOW_NOT_FOUND",404);
  if(w.version!==ref.expectedWorkflowVersion||w.evidenceDigest!==ref.expectedEvidenceDigest)fail("OPPORTUNITY_CAS_CONFLICT");
  const a=await assignment(tx,session,ref,w.id,bucket.id,session.userId);assignments.set(w.id,a);
  const binding=bind(s,a),origin=a.origin,observation=s.row.observationId;
  const signals:PortfolioInput["candidates"][number]["signals"]=[];
  for(const [kind,evidenceKind] of [["FIT","IDENTITY"],["NEED","BUSINESS_NEED"]] as const){const facts=qualifyWebsiteProspect(s.row.prospect,now()).input.evidence.filter(e=>e.kind===evidenceKind);if(facts.length)signals.push({origin,kind,value:Math.floor(Math.min(...facts.map(f=>f.confidence))*100),sourceId:observation,sourceDigest:w.evidenceDigest,observedAt:binding.observedAt,validUntil:binding.validUntil});}
  let dialogSourceId:string|null=null;let clarificationOnly=false;let dialogSourceHash:string|null=null;
  if(ref.purpose==="NEW_CUSTOMER_DIALOG"&&ref.dialogSourceId){const installed=await tx.queryOne<{ok:boolean}>("select to_regclass('public.crm_website_sales_conversations') is not null as ok");if(installed?.ok){const topic=await readCurrentSalesConversationTopic(tx,session,ref,ref.dialogSourceId);if(topic&&topic.topicCode!=="OPT_OUT"){dialogSourceId=topic.messageId;dialogSourceHash=topic.sourceHash;clarificationOnly=topic.clarificationOnly;}}}
  if(dialogSourceHash)dialogSourceHashes.set(w.id,dialogSourceHash);
  const kind=ref.requestedStage==="DEMO"||ref.requestedStage==="CONCEPT_ACCEPTANCE"?"CONCEPT":"DIAGNOSIS";
  const previous=await tx.queryOne<{id:string;artifact:{artifactDigest:string;evidenceDigest:string;createdAt:string;kind:"DIAGNOSIS"|"CONCEPT"};acceptedAt:string|null}>(`select a.id,a.artifact,(select min(x.accepted_at)::text from crm_website_studio_acceptances x where x.workspace_id=a.workspace_id and x.artifact_id=a.id) as "acceptedAt" from crm_website_studio_artifacts a where a.workspace_id=$1 and a.workflow_id=$2 and a.kind=$3 and a.evidence_digest=$4 order by a.version desc limit 1`,[session.workspaceId,w.id,kind,w.evidenceDigest]);
  const complete=await tx.queryOne(`select id from crm_website_studio_artifacts where workspace_id=$1 and workflow_id=$2 and kind=$3 and evidence_digest=$4`,[session.workspaceId,w.id,ref.requestedStage,w.evidenceDigest]);
  const estimates=rule.settings.stageEstimates as {stage:string;estimatedCostMinor:number;requiredMinutes:number}[]|undefined;const investment=estimates?.find(x=>x.stage===ref.requestedStage);const blocked=clarificationOnly&&w.blockedReason==="STALE_OR_UNQUALIFIED_EVIDENCE"?null:w.blockedReason??(complete||ref.requestedStage==="CONCEPT_ACCEPTANCE"&&previous?.acceptedAt||ref.requestedStage!=="CONCEPT_ACCEPTANCE"&&!investment?"OTHER":null);
  candidates.push({binding,status:w.status==="OBSERVED"?"OPEN":w.status,qualificationStatus:w.qualificationStatus,requestedStage:ref.requestedStage,
   purpose:ref.purpose,stopReason:blocked===null?null:["REPLY_RECEIVED","OPT_OUT","UNKNOWN_DELIVERY","IDENTITY_AMBIGUOUS","STALE_EVIDENCE","NO_FIT","OTHER"].includes(blocked)?blocked as PortfolioInput["candidates"][number]["stopReason"]:"STALE_EVIDENCE",dialogSourceId,estimatedCostMinor:ref.requestedStage==="CONCEPT_ACCEPTANCE"?0:investment?.estimatedCostMinor??Number.MAX_SAFE_INTEGER,
   requiredMinutes:ref.requestedStage==="CONCEPT_ACCEPTANCE"?1:investment?.requiredMinutes??Number.MAX_SAFE_INTEGER,signals,assetRightsReference:previous?.id??null,
   stagePrerequisite:previous?{stage:previous.artifact.kind,artifactId:previous.id,artifactDigest:previous.artifact.artifactDigest,evidenceDigest:previous.artifact.evidenceDigest,completedAt:previous.artifact.createdAt,acceptedAt:previous.acceptedAt?new Date(previous.acceptedAt).toISOString():null}:null});
 }
 const used=await capacity(tx,session,bucket);const input:PortfolioInput={scope:{workspaceId:session.workspaceId,projectId:c.projectId},revision:revision(bucket.version,bucket),policy:portfolioPolicySchema.parse(rule.policy),
  resources:{budgetId:bucket.id,budgetVersion:bucket.version,capacityId:bucket.id,capacityVersion:bucket.version,availableBudgetMinor:Math.max(0,n(bucket.budgetMinor)-used.budget),availableMinutes:Math.max(0,n(bucket.capacityMinutes)-used.minutes),observedAt:now(),validUntil:new Date(bucket.windowEnd).toISOString()},candidates};
 const result=planWebsiteSalesPortfolio(input,now());
 const priorAssignments=await tx.query<{workflowId:string;companyId:string}>("select distinct workflow_id as \"workflowId\",company_id as \"companyId\" from crm_website_sales_ops_allocations where workspace_id=$1 and portfolio_id=$2 and created_at>=$3::timestamptz and status<>'RELEASED'",[session.workspaceId,bucket.id,bucket.windowStart]);
 const reservedWorkflows=new Set(priorAssignments.map(x=>x.workflowId)),counts=new Map<string,number>();for(const x of priorAssignments)counts.set(x.companyId,(counts.get(x.companyId)??0)+1);
 const serverReservationSkips:{opportunityId:string;reason:string}[]=[],allocationIds:string[]=[];for(const selected of result.reservations){const active=await tx.queryOne<{id:string}>("select id from crm_website_sales_ops_allocations where workspace_id=$1 and workflow_id=$2 and stage=$3 and status in('RESERVED','CLAIMED')",[session.workspaceId,selected.opportunityId,selected.requestedStage]);if(active){allocationIds.push(active.id);continue;}
  if(!reservedWorkflows.has(selected.opportunityId)&&(reservedWorkflows.size>=input.policy.maxOpportunities||(counts.get(selected.identity.companyId)??0)>=input.policy.maxPerCompany)){serverReservationSkips.push({opportunityId:selected.opportunityId,reason:"CURRENT_PORTFOLIO_COUNT_CAP"});continue;}
  if(!reservedWorkflows.has(selected.opportunityId)){reservedWorkflows.add(selected.opportunityId);counts.set(selected.identity.companyId,(counts.get(selected.identity.companyId)??0)+1);}
  const a=assignments.get(selected.opportunityId)!;const ranked=result.ranked.find(r=>r.opportunityId===selected.opportunityId)!;
  const allocationId=randomUUID();allocationIds.push(allocationId);await tx.execute(`insert into crm_website_sales_ops_allocations(id,workspace_id,project_id,company_id,location_id,workflow_id,portfolio_id,assignment_id,stage,amount_minor,capacity_minutes,expires_at,decision,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,[allocationId,session.workspaceId,c.projectId,selected.identity.companyId,selected.identity.locationId,selected.opportunityId,bucket.id,a.id,selected.requestedStage,selected.costMinor,selected.minutes,bucket.windowEnd,JSON.stringify({ranked,expectedBinding:selected.expectedBinding,purpose:candidates.find(x=>x.binding.opportunityId===selected.opportunityId)!.purpose,dialogSourceId:candidates.find(x=>x.binding.opportunityId===selected.opportunityId)!.dialogSourceId,dialogSourceHash:dialogSourceHashes.get(selected.opportunityId)??null}),session.userId]);
 }
 await tx.execute("update crm_website_sales_ops_portfolios set version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2",[session.workspaceId,bucket.id]);
 return{portfolioId:bucket.id,allocationIds,serverReservationSkips,version:bucket.version+1,plan:result,canContact:false};
}

type AllocationRow=SalesOperationsRead["allocations"][number]&{leaseToken:string|null;claimedBy:string|null;sealedCommand:unknown;sealedDigest:string|null;stageOperationId:string|null;current:boolean};
const allocationCols=`a.id,a.project_id as "projectId",a.company_id as "companyId",a.location_id as "locationId",a.workflow_id as "workflowId",a.portfolio_id as "portfolioId",a.assignment_id as "assignmentId",a.version,a.stage,a.amount_minor as "amountMinor",a.capacity_minutes as "capacityMinutes",a.status,a.expires_at::text as "expiresAt",a.decision,a.lease_token as "leaseToken",a.claimed_by as "claimedBy",a.sealed_command as "sealedCommand",a.sealed_digest as "sealedDigest",a.stage_operation_id as "stageOperationId",a.expires_at>clock_timestamp() and p.window_end>clock_timestamp() as current`;
async function allocation(tx:TenantTransaction,session:AppSession,id:string){return tx.queryOne<AllocationRow>(`select ${allocationCols} from crm_website_sales_ops_allocations a join crm_website_sales_ops_portfolios p on p.workspace_id=a.workspace_id and p.id=a.portfolio_id where a.workspace_id=$1 and a.id=$2 for update of a`,[session.workspaceId,id]);}
async function claim(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"claim_allocation"),a=await allocation(tx,session,p.allocationId);if(!a)fail("ALLOCATION_NOT_FOUND",404);await guard(tx,session,a,true);
 if(a.projectId!==c.projectId||a.companyId!==c.companyId||a.locationId!==c.locationId)fail("ALLOCATION_SCOPE_DENIED",403);
 checkedVersion(c.expectedVersion,a.version);checkedVersion(p.expectedAllocationVersion,a.version);if(a.status!=="RESERVED"||!a.current)fail("ALLOCATION_NOT_AVAILABLE");
 const r=p.stageCommand.request;if(r.allocationProof!==undefined)fail("SEALED_COMMAND_MUST_EXCLUDE_PROOF",400);
 if(r.projectId!==a.projectId||r.companyId!==a.companyId||r.locationId!==a.locationId||!z.uuidv4().safeParse(r.idempotencyKey).success||!uuid.safeParse(r.correlationId).success)fail("SEALED_COMMAND_SCOPE_DENIED",403);
 const stageMap={DIAGNOSIS:"create_diagnosis",CONCEPT:"create_concept",CONCEPT_ACCEPTANCE:"accept_concept",DEMO:"build_demo",CONVERSATION:"advance_conversation"};
 if(r.operation!==stageMap[a.stage]||p.stageCommand.target!==(a.stage==="CONVERSATION"?"autonomy":"studio"))fail("ALLOCATION_STAGE_COMMAND_DENIED");
 const s=await websiteSalesIrelandState(tx,session,a,true),w=s.current.workflow;if(!w)fail("WORKFLOW_NOT_FOUND",404);
 const expected=a.decision.expectedBinding as OperationsBinding;
 if(w.id!==a.workflowId)fail("ALLOCATION_CANDIDATE_ID_CHANGED");if(w.version!==expected.workflowVersion)fail("ALLOCATION_CANDIDATE_VERSION_CHANGED");if(w.evidenceDigest!==expected.evidenceDigest)fail("ALLOCATION_CANDIDATE_EVIDENCE_CHANGED");
 let clarificationOnly=false;
 if(a.stage==="CONVERSATION"){
  const id=a.decision.dialogSourceId;if(typeof id!=="string"||(r.payload as Json|undefined)?.canonicalMessageId!==id)fail("ALLOCATION_DIALOG_SOURCE_DENIED");
  const topic=await readCurrentSalesConversationTopic(tx,session,a,id);if(!topic||topic.sourceHash!==a.decision.dialogSourceHash)fail("ALLOCATION_DIALOG_SOURCE_CHANGED");clarificationOnly=topic.clarificationOnly;
 }
 if(w.blockedReason&&!(a.stage==="CONVERSATION"&&(w.blockedReason==="REPLY_RECEIVED"||clarificationOnly&&w.blockedReason==="STALE_OR_UNQUALIFIED_EVIDENCE")))fail(w.blockedReason);
 if(r.expectedWorkflowVersion!==w.version)fail("SEALED_COMMAND_WORKFLOW_VERSION_DENIED");
 if(a.stage!=="CONVERSATION"&&r.expectedEvidenceDigest!==w.evidenceDigest)fail("SEALED_COMMAND_EVIDENCE_DENIED");
 if(!["CONCEPT_ACCEPTANCE","CONVERSATION"].includes(a.stage)){const input=r.payload as Json|undefined,plan=input?.investmentPlan as Json|undefined;if(!plan||plan.estimatedCostMinor!==n(a.amountMinor)||plan.requiredCapacityMinutes!==n(a.capacityMinutes)||!Number.isSafeInteger(plan.availableBudgetMinor)||Number(plan.availableBudgetMinor)>n(a.amountMinor)||!Number.isSafeInteger(plan.availableCapacityMinutes)||Number(plan.availableCapacityMinutes)>n(a.capacityMinutes)||plan.budgetReference!==`crm-allocation:${a.id}:${a.version}`)fail("SEALED_STAGE_COST_BINDING_DENIED");}
 const leaseToken=randomUUID(),expiresAt=new Date(Math.min(Date.parse(a.expiresAt),Date.now()+15*60_000)).toISOString(),sealed=salesStageCommand(p.stageCommand.target,r);
 await tx.execute(`update crm_website_sales_ops_allocations set version=version+1,status='CLAIMED',lease_token=$3,claimed_by=$4,sealed_command=$5::jsonb,sealed_digest=$6,stage_operation_id=$7,expires_at=$8,updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,[session.workspaceId,a.id,leaseToken,session.userId,JSON.stringify(sealed),crmPayloadDigest(sealed),r.idempotencyKey,expiresAt]);
 return{allocationId:a.id,allocationProof:{allocationId:a.id,version:a.version+1,leaseToken},expiresAt,stageOperationId:String(r.idempotencyKey),version:a.version+1,canContact:false as const};
}
async function settle(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"settle_allocation"),a=await allocation(tx,session,p.allocationId);if(!a)fail("ALLOCATION_NOT_FOUND",404);await guard(tx,session,a,true);
 if(a.projectId!==c.projectId||a.companyId!==c.companyId||a.locationId!==c.locationId)fail("ALLOCATION_SCOPE_DENIED",403);
 checkedVersion(c.expectedVersion,a.version);checkedVersion(p.expectedAllocationVersion,a.version);
 if(a.status!=="CLAIMED"&&!(a.status==="RESERVED"&&p.outcome==="RELEASED"))fail("ALLOCATION_SETTLED");
 if(session.serviceIdentity&&a.claimedBy!==session.userId)fail("ALLOCATION_ACTOR_DENIED",403);
 const effect=await tx.queryOne<{commandId:string}>("select command_id as \"commandId\" from crm_website_sales_ops_effects where workspace_id=$1 and allocation_id=$2",[session.workspaceId,a.id]);
 if(p.outcome==="COMPLETED"&&(!effect||effect.commandId!==p.receiptCommandId))fail("COMMITTED_STAGE_RECEIPT_REQUIRED");
 // A missing effect is not proof of non-dispatch. A claimed UNKNOWN stays reserved until exact reconciliation.
 if(p.outcome==="RELEASED"&&a.status==="CLAIMED"){
  await owner(tx,session);if(a.current||effect||!a.sealedCommand||crmPayloadDigest(a.sealedCommand)!==a.sealedDigest)fail("UNKNOWN_ALLOCATION_MUST_RECONCILE");
  if(await tx.queryOne("select id from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[session.workspaceId,a.stageOperationId]))fail("COMMITTED_STAGE_MUST_SETTLE");
 }else if(p.outcome==="RELEASED"&&effect)fail("UNKNOWN_ALLOCATION_MUST_RECONCILE");
 await tx.execute("update crm_website_sales_ops_allocations set version=version+1,status=$3,updated_at=clock_timestamp() where workspace_id=$1 and id=$2",[session.workspaceId,a.id,p.outcome]);
 return{allocationId:a.id,version:a.version+1,canContact:false as const};
}
function childKey(key:string,label:string){const h=createHash("sha256").update(`sales-operations:${label}:${key}`).digest("hex");return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
async function registerPrice(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,commandId:string){
 const p=payload(c,"register_price_rule");await owner(tx,session);let version=0;
 if(p.policyGroupId){const previous=await tx.queryOne<{version:number}>("select version from crm_website_sales_ops_policies where workspace_id=$1 and project_id=$2 and policy_group_id=$3 and kind='PRICING' order by version desc limit 1",[session.workspaceId,c.projectId,p.policyGroupId]);if(!previous)fail("PRICE_RULE_NOT_FOUND",404);version=previous.version;}
 checkedVersion(c.expectedVersion,version);const result=await approvedPolicy(tx,session,c.projectId,"PRICING",p.label,p.policy,commandId,p.policyGroupId,true,{estimatedDeliveryCostMinor:p.estimatedDeliveryCostMinor,skuLabels:p.skuLabels??{}});
 return{ruleId:result.id,policyId:result.id,version:result.version,canContact:false as const};
}
async function lockedPriceState(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 // The outer operations transaction already owns the project lock. Match lifecycle refresh:
 // location/workflow -> deal -> offer -> quote, before checking or changing any price binding.
 const s=await state(tx,session,c,{allowReply:true,lock:true}),w=s.current.workflow!;checkedVersion(c.expectedVersion,w.version);
 const deal=await tx.queryOne("select id from deals where workspace_id=$1 and project_id=$2 and id=$3 and contact_id=$4 and lead_id=$5 and organization_id=$6 for update",[session.workspaceId,c.projectId,w.dealId,w.contactId,w.leadId,c.companyId]);
 if(!deal)fail("DEAL_SCOPE_DENIED",403);
 const locked=await tx.queryOne("select id from crm_offers where workspace_id=$1 and project_id=$2 and id=$3 and deal_id=$4 for update",[session.workspaceId,c.projectId,w.offerDraftId,w.dealId]);
 if(!locked)fail("CANONICAL_OFFER_DRAFT_REQUIRED");
 const offer=await offers(tx,session,w);if(offer.status!=="DRAFT")fail("DRAFT_ONLY_PRICE_REVIEW_REQUIRED");
 return{s,w,offer};
}
async function priceInput(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,p:z.infer<typeof payloads.propose_price>){
 const {s,w,offer}=await lockedPriceState(tx,session,c);
 const rule=await policy(tx,session,p.ruleId,"PRICING",true,c.projectId);checkedVersion(p.ruleVersion,rule.version);
 const bucket=await portfolio(tx,session,c.projectId,true);if(!bucket)fail("PORTFOLIO_REQUIRED");const a=await assignment(tx,session,c,w.id,bucket.id,session.userId);
 const prior=await tx.queryOne<QuoteRow>(`select ${qcols} from crm_website_sales_ops_quotes where workspace_id=$1 and workflow_id=$2 order by created_at desc,id desc limit 1`,[session.workspaceId,w.id]);
 if(p.mode==="AUTO_COUNTEROFFER"){
  if(!p.dialogSourceId)fail("PRICE_OBJECTION_SOURCE_REQUIRED");
  const available=await tx.queryOne<{ok:boolean}>("select to_regclass('public.crm_website_sales_conversation_turns') is not null as ok");if(!available?.ok)fail("PRICE_OBJECTION_SOURCE_REQUIRED");
  const topic=await readCurrentSalesConversationTopic(tx,session,c,p.dialogSourceId);if(!topic||!["OBJECTION_PRICE","DISCOUNT"].includes(topic.topicCode))fail("PRICE_OBJECTION_SOURCE_REQUIRED");
 }
 const input:PricingInput={scope:{workspaceId:session.workspaceId,projectId:c.projectId},revision:{version:(prior?.quote.revision.version??0)+1,previousDigest:prior?.quoteDigest??null},binding:bind(s,a),policy:pricingPolicySchema.parse(rule.policy),
  terms:{scopeDigest:scopeDigest(offer.content),offerId:offer.id,offerVersion:offer.version,offerDigest:offer.contentDigest,contractId:null,contractVersion:null,contractDigest:null,contractStatus:null},lines:p.lines,requestedDiscountBps:p.requestedDiscountBps,
  estimatedDeliveryCostMinor:n(rule.settings.estimatedDeliveryCostMinor),negotiationRound:p.mode==="INITIAL"?1:(prior?.quote.negotiationRound??0)+1,previousQuoteDigest:prior?.quoteDigest??null,mode:p.mode,priorProposal:prior?.quote??null,
  priorApplication:prior?.status==="APPLIED"?{quoteDigest:prior.quoteDigest,offerId:prior.offerId,offerVersion:prior.offerVersion,offerDigest:prior.offerDigest,appliedAt:new Date(prior.appliedAt!).toISOString()}:null};
 return{input,offer,rule,s};
}
async function proposePrice(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"propose_price"),{input,offer}=await priceInput(tx,session,c,p),quote=createWebsiteSalesPriceProposal(input,now()),id=randomUUID();
 await tx.execute(`insert into crm_website_sales_ops_quotes(id,workspace_id,project_id,company_id,location_id,workflow_id,rule_id,rule_version,quote,quote_digest,offer_id,offer_version,offer_revision,offer_digest,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,[id,session.workspaceId,c.projectId,c.companyId,c.locationId,input.binding.workflowId,p.ruleId,p.ruleVersion,JSON.stringify(quote),quote.proposalDigest,offer.id,offer.version,offer.revision,offer.contentDigest,session.userId]);
 return{quoteId:id,version:input.binding.workflowVersion,canContact:false as const};
}
async function applyQuote(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,options:TenantTransactionOptions){
 const {s,w,offer}=await lockedPriceState(tx,session,c);
 const p=payload(c,"apply_quote"),q=await tx.queryOne<QuoteRow>(`select ${qcols} from crm_website_sales_ops_quotes where workspace_id=$1 and id=$2 and project_id=$3 and company_id=$4 and location_id=$5 for update`,[session.workspaceId,p.quoteId,c.projectId,c.companyId,c.locationId]);if(!q||q.quoteDigest!==p.quoteDigest)fail("CURRENT_QUOTE_REQUIRED");checkedVersion(p.expectedQuoteVersion,q.version);
 if(q.status!=="PROPOSED"||q.quote.status==="BLOCKED"||Date.parse(q.quote.validUntil)<=Date.now())fail("QUOTE_BLOCKED_OR_EXPIRED");
 await policy(tx,session,q.ruleId,"PRICING",true,c.projectId);
 const {proposalDigest,...unsigned}=q.quote;if(proposalDigest!==websiteSalesOperationsDigest(unsigned)||crmPayloadDigest(bind(s,await assignment(tx,session,c,w.id,(await portfolio(tx,session,c.projectId))!.id,session.userId)))!==crmPayloadDigest(q.quote.binding))fail("QUOTE_BINDING_CHANGED");
 if(offer.id!==q.offerId||offer.version!==q.offerVersion||offer.revision!==q.offerRevision||offer.contentDigest!==q.offerDigest)fail("QUOTE_OFFER_CHANGED");
 const content=parseOfferContent({...offer.content,discounts:`Rule-bounded draft discount: ${q.quote.requestedDiscountBps} basis points. Final offer approval required.`,validUntil:q.quote.validUntil,
  items:q.quote.lines.map(line=>({description:line.sku,quantity:1,unitNetCents:line.netMinor}))});
 await executeOfferCommand(session,{operation:"revise",offerId:offer.id,projectId:c.projectId,expectedVersion:offer.version,idempotencyKey:childKey(c.idempotencyKey,"quote-offer"),correlationId:c.correlationId,payload:{content}},options);
 const current=await offers(tx,session,w);await tx.execute("update crm_website_sales_ops_quotes set status='APPLIED',version=version+1,offer_version=$3,offer_revision=$4,offer_digest=$5,applied_at=clock_timestamp() where workspace_id=$1 and id=$2",[session.workspaceId,q.id,current.version,current.revision,current.contentDigest]);
 await tx.execute(`update tasks set metadata=metadata||$3::jsonb,version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id in(select task_id from crm_website_sales_handoffs where workspace_id=$1 and workflow_id=$2)`,[session.workspaceId,w.id,JSON.stringify({websiteSalesHandoffStatus:"REPRICED_REVIEW_REQUIRED",supersededByQuoteId:q.id})]);
 const advanced=await tx.queryOne("update crm_website_sales_workflows set version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and project_id=$2 and id=$3 and version=$4 returning id",[session.workspaceId,c.projectId,w.id,c.expectedVersion]);
 if(!advanced)fail("VERSION_CONFLICT");
 return{quoteId:q.id,version:w.version+1,canContact:false as const};
}

async function registerEvidence(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,commandId:string){
 await owner(tx,session);const p=payload(c,"register_financial_evidence"),s=await websiteSalesIrelandState(tx,session,c,true),w=s.current.workflow;if(!w)fail("WORKFLOW_NOT_FOUND",404);checkedVersion(c.expectedVersion,w.version);
 const bucket=await portfolio(tx,session,c.projectId,true);if(!bucket)fail("PORTFOLIO_REQUIRED");const a=await assignment(tx,session,c,w.id,bucket.id,session.userId),id=randomUUID();
 const nonfinancial=["NO_RESPONSE","ABANDONED","FULFILLED"].includes(p.kind);
 if(nonfinancial&&p.sourceSystem!=="CRM"||!nonfinancial&&p.sourceSystem==="CRM")fail("FINANCIAL_SOURCE_KIND_INVALID",400);
 // CRM observations are explicit owner attestations recorded by this actual canonical command, not bank or delivery verification.
 
 const body={...p,recordId:nonfinancial?commandId:p.recordId,sourceId:id,origin:a.origin,observedAt:now(),approvalReference:nonfinancial?null:commandId,sourceConfidence:nonfinancial?"CRM_CANONICAL_EVENT" as const:"OPERATOR_RECORDED_FINANCIAL_DOCUMENT" as const};
 const source=outcomeSourceSchema.parse({...body,sourceDigest:websiteSalesOutcomeSourceDigest(body)});
 const originals=await tx.query<{source:z.infer<typeof outcomeSourceSchema>}>("select source from crm_website_sales_ops_financial_sources where workspace_id=$1 and project_id=$2 order by created_at,id limit 5001",[session.workspaceId,c.projectId]);if(originals.length>=5000)fail("COHORT_EVENT_WINDOW_LIMIT_REQUIRED");
 const originalCohort=await cohort(tx,session,c.projectId,1);if(!originalCohort)fail("COHORT_REQUIRED");
 // This validates identity-preserving corrections, economic-event dedupe, actual/commitment distinctions and reversal bounds before persistence.
 summarizeWebsiteSalesOutcomes({...originalCohort,events:[...originals.map(x=>({eventId:x.source.sourceId,source:x.source})),{eventId:id,source}]},now());
 await tx.execute(`insert into crm_website_sales_ops_financial_sources(id,workspace_id,project_id,company_id,location_id,workflow_id,assignment_id,source_system,record_id,economic_event_id,record_version,source_hash,source,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,[id,session.workspaceId,c.projectId,c.companyId,c.locationId,w.id,a.id,p.sourceSystem,p.recordId,p.economicEventId,p.recordVersion,source.sourceDigest,JSON.stringify(source),session.userId]);
 return{financialEvidenceId:id,version:w.version,canContact:false as const};
}
async function recordOutcome(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"record_outcome"),s=await websiteSalesIrelandState(tx,session,c,true),w=s.current.workflow;if(!w)fail("WORKFLOW_NOT_FOUND",404);checkedVersion(c.expectedVersion,w.version);
 const saved=await tx.queryOne<{id:string;source:z.infer<typeof outcomeSourceSchema>;sourceHash:string}>(`select id,source,source_hash as "sourceHash" from crm_website_sales_ops_financial_sources where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6`,[session.workspaceId,c.projectId,c.companyId,c.locationId,w.id,p.sourceId]);
 if(!saved||saved.sourceHash!==p.canonicalSourceHash||websiteSalesOutcomeSourceDigest(saved.source)!==saved.sourceHash)fail("CANONICAL_FINANCIAL_SOURCE_REQUIRED");
 const previous=await tx.queryOne<{id:string}>("select id from crm_website_sales_ops_outcomes where workspace_id=$1 and source_id=$2",[session.workspaceId,saved.id]);if(previous)return{outcomeId:previous.id,version:w.version,canContact:false as const};
 const current=await cohort(tx,session,c.projectId,1,c);if(!current)fail("COHORT_REQUIRED");const id=randomUUID(),event={eventId:id,source:saved.source};summarizeWebsiteSalesOutcomes({...current,events:[...current.events,event]},now());
 await tx.execute(`insert into crm_website_sales_ops_outcomes(id,workspace_id,project_id,company_id,location_id,workflow_id,source_id,source_digest,event,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[id,session.workspaceId,c.projectId,c.companyId,c.locationId,w.id,saved.id,saved.sourceHash,JSON.stringify(event),session.userId]);
 return{outcomeId:id,version:w.version,canContact:false as const};
}
async function improvementInput(tx:TenantTransaction,session:AppSession,projectId:string,ruleId:string,value:number){
 const rule=await policy(tx,session,ruleId,"IMPROVEMENT",true,projectId),current=await cohort(tx,session,projectId,1);if(!current)fail("COHORT_REQUIRED");
 const target=await policy(tx,session,String(rule.settings.targetPolicyId),undefined,true,projectId);const parsed=improvementRuleSchema.parse(rule.policy);if(target.kind!==(parsed.permittedField==="MAX_OPPORTUNITY_COST_MINOR"?"PORTFOLIO":"PRICING"))fail("IMPROVEMENT_TARGET_KIND_DENIED");
 let actual:number;if(parsed.permittedField==="MAX_OPPORTUNITY_COST_MINOR")actual=n(target.policy.maxCostPerOpportunityMinor);
 else if(parsed.permittedField==="MIN_MARGIN_BPS")actual=n(target.policy.minimumMarginBps);
 else{const product=pricingPolicySchema.parse(target.policy).products.find(x=>x.sku===rule.settings.targetSku);if(!product)fail("IMPROVEMENT_PRODUCT_REQUIRED");actual=product.maxDiscountBps;}
 if(actual!==parsed.currentValue)fail("IMPROVEMENT_TARGET_CHANGED");
 return{input:{scope:{workspaceId:session.workspaceId,projectId},revision:{version:1,previousDigest:null},rule:parsed,cohort:current,proposedValue:value},rule,target};
}
async function proposeImprovement(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"propose_improvement"),bucket=await portfolio(tx,session,c.projectId,true);if(!bucket)fail("PORTFOLIO_REQUIRED");checkedVersion(c.expectedVersion,bucket.version);
 const loaded=await improvementInput(tx,session,c.projectId,p.ruleId,p.proposedValue??0);
 const recommendation=p.proposedValue===undefined?recommendWebsiteSalesImprovementValue({scope:loaded.input.scope,revision:loaded.input.revision,rule:loaded.input.rule,cohort:loaded.input.cohort},now()):null;
 if(recommendation&&recommendation.status!=="REQUIRES_REVIEW")fail("NO_ELIGIBLE_DEFENSIVE_IMPROVEMENT");
 const input={...loaded.input,proposedValue:p.proposedValue??recommendation!.proposedValue},rule=loaded.rule,target=loaded.target,proposal=proposeWebsiteSalesImprovement(input,now()),id=randomUUID();
 await tx.execute(`insert into crm_website_sales_ops_improvements(id,workspace_id,project_id,candidate_digest,candidate,target_policy_id,created_by) values($1,$2,$3,$4,$5::jsonb,$6,$7)`,[id,session.workspaceId,c.projectId,proposal.proposalDigest,JSON.stringify({proposal,ruleId:rule.id,recommendation}),target.id,session.userId]);
 return{improvementId:id,version:bucket.version,canContact:false as const};
}
type ImprovementRow={id:string;candidateDigest:string;candidate:{proposal:ReturnType<typeof proposeWebsiteSalesImprovement>;ruleId:string};targetPolicyId:string;version:number};
async function improvement(tx:TenantTransaction,session:AppSession,projectId:string,id:string,digest:string){const row=await tx.queryOne<ImprovementRow>(`select id,candidate_digest as "candidateDigest",candidate,target_policy_id as "targetPolicyId",version from crm_website_sales_ops_improvements where workspace_id=$1 and project_id=$2 and id=$3`,[session.workspaceId,projectId,id]);if(!row||row.candidateDigest!==digest)fail("EXACT_IMPROVEMENT_REQUIRED");return row;}
async function reviewImprovement(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand,commandId:string){
 await owner(tx,session);const p=payload(c,"review_improvement"),bucket=await portfolio(tx,session,c.projectId,true);if(!bucket)fail("PORTFOLIO_REQUIRED");checkedVersion(c.expectedVersion,bucket.version);
 if(Date.parse(p.validUntil)<=Date.now()||Date.parse(p.validUntil)>Date.now()+86400000)fail("BOUNDED_PROMOTION_APPROVAL_REQUIRED");
 const row=await improvement(tx,session,c.projectId,p.improvementId,p.candidateDigest),{input,target,rule:improvementRule}=await improvementInput(tx,session,c.projectId,row.candidate.ruleId,row.candidate.proposal.proposedValue);
 const approval={approvalId:commandId,approvedBy:session.userId,approvedAt:now(),validUntil:p.validUntil,contentDigest:p.candidateDigest};
 if(p.decision==="APPROVED"&&evaluateWebsiteSalesImprovementPromotion(row.candidate.proposal,input,approval,now()).status!=="ELIGIBLE_FOR_SERVER_PROMOTION")fail("IMPROVEMENT_REVIEW_NOT_ELIGIBLE");
 const id=randomUUID();let nextPolicyId:string|null=null;let snapshot:Json={approval};
 if(p.decision==="APPROVED"){
  const raw={...target.policy} as Json;delete raw.policyId;delete raw.scope;delete raw.revision;delete raw.approval;
  const proposed=row.candidate.proposal;
  if(proposed.field==="MAX_OPPORTUNITY_COST_MINOR")raw.maxCostPerOpportunityMinor=proposed.proposedValue;
  else if(proposed.field==="MIN_MARGIN_BPS")raw.minimumMarginBps=proposed.proposedValue;
  else raw.products=pricingPolicySchema.parse(target.policy).products.map(x=>x.sku===String(improvementRule.settings.targetSku)?{...x,maxDiscountBps:proposed.proposedValue}:x);
  const next=await approvedPolicy(tx,session,c.projectId,target.kind,`${target.label} / reviewed improvement`,raw,commandId,target.policyGroupId,false,target.settings);nextPolicyId=next.id;snapshot={approval,targetPolicyId:target.id,policyId:next.id,policyDigest:next.digest};
 }
 const previous=await tx.queryOne<{version:number}>("select version from crm_website_sales_ops_decisions where workspace_id=$1 and improvement_id=$2 order by version desc limit 1",[session.workspaceId,row.id]);
 await tx.execute(`insert into crm_website_sales_ops_decisions(id,workspace_id,project_id,improvement_id,proposal_version,candidate_digest,decision,policy_id,snapshot,valid_until,created_by,version) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,[id,session.workspaceId,c.projectId,row.id,row.version,p.candidateDigest,p.decision,nextPolicyId,JSON.stringify(snapshot),p.validUntil,session.userId,(previous?.version??0)+1]);
 return{improvementId:row.id,decisionId:id,version:bucket.version,canContact:false as const};
}
async function promoteImprovement(tx:TenantTransaction,session:AppSession,c:SalesOperationsCommand){
 const p=payload(c,"promote_improvement"),bucket=await portfolio(tx,session,c.projectId,true);if(!bucket)fail("PORTFOLIO_REQUIRED");checkedVersion(c.expectedVersion,bucket.version);
 const row=await improvement(tx,session,c.projectId,p.improvementId,p.candidateDigest),decision=await tx.queryOne<{id:string;policyId:string|null;snapshot:Json;eligible:boolean}>(`select d.id,d.policy_id as "policyId",d.snapshot,d.decision='APPROVED' and d.valid_until>clock_timestamp() and u.role='owner' and u.status='active' and not exists(select 1 from crm_website_sales_ops_decisions newer where newer.workspace_id=d.workspace_id and newer.improvement_id=d.improvement_id and newer.version>d.version) as eligible from crm_website_sales_ops_decisions d join workspace_users u on u.workspace_id=d.workspace_id and u.id=d.created_by where d.workspace_id=$1 and d.project_id=$2 and d.improvement_id=$3 and d.id=$4 and d.candidate_digest=$5`,[session.workspaceId,c.projectId,row.id,p.decisionId,p.candidateDigest]);
 if(!decision?.eligible||!decision.policyId)fail("CURRENT_HUMAN_PROMOTION_APPROVAL_REQUIRED");
 const {input}=await improvementInput(tx,session,c.projectId,row.candidate.ruleId,row.candidate.proposal.proposedValue);
 if(evaluateWebsiteSalesImprovementPromotion(row.candidate.proposal,input,decision.snapshot.approval,now()).status!=="ELIGIBLE_FOR_SERVER_PROMOTION")fail("IMPROVEMENT_REVALIDATION_FAILED");
 const next=await policy(tx,session,decision.policyId,undefined,false,c.projectId);if(next.policyDigest!==decision.snapshot.policyDigest||decision.snapshot.targetPolicyId!==row.targetPolicyId)fail("EXACT_BOUNDED_POLICY_SNAPSHOT_REQUIRED");
 await tx.execute("insert into crm_website_sales_ops_activations(id,workspace_id,project_id,policy_id,decision_id,created_by) values($1,$2,$3,$4,$5,$6)",[randomUUID(),session.workspaceId,c.projectId,next.id,decision.id,session.userId]);
 if(next.kind==="PORTFOLIO")await tx.execute("update crm_website_sales_ops_portfolios set policy_id=$3,version=version+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2",[session.workspaceId,bucket.id,next.id]);
 return{improvementId:row.id,policyId:next.id,version:bucket.version+(next.kind==="PORTFOLIO"?1:0),canContact:false as const};
}

async function opportunities(tx:TenantTransaction,session:AppSession,projectId:string):Promise<Pick<SalesOperationsRead,"opportunities"|"opportunitiesHasMore">>{
 const resources=websiteSalesResourceReadScopes(session,projectId);
 const rows=await tx.query<SalesOperationsScope>(`select w.project_id as "projectId",w.company_id as "companyId",w.location_id as "locationId"
  from crm_website_sales_workflows w join projects p on p.workspace_id=w.workspace_id and p.id=w.project_id
  join organizations o on o.workspace_id=w.workspace_id and o.project_id=w.project_id and o.id=w.company_id
  join crm_company_locations l on l.workspace_id=w.workspace_id and l.project_id=w.project_id and l.company_id=w.company_id and l.id=w.location_id
  where w.workspace_id=$1 and w.project_id=$2 and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales'
   and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'
   ${resources?`and exists(select 1 from jsonb_to_recordset($3::jsonb) as permitted("companyId" uuid,"locationId" uuid) where permitted."companyId"=w.company_id and permitted."locationId"=w.location_id)`:""}
  order by o.name,l.address,w.id limit 201`,[session.workspaceId,projectId,...(resources?[JSON.stringify(resources.map(r=>({companyId:r.companyId,locationId:r.locationId})))]:[])]);
 const access=await tx.queryOne<{allowed:boolean}>("select crm_project_access($1,$2,true) as allowed",[session.workspaceId,projectId]);
 const canWrite=!!access?.allowed&&session.permissions.includes("crm:write")&&session.productPermissions.includes("pipeline:write"),items:SalesOperationsRead["opportunities"]=[];
 for(const candidate of rows){
  await guard(tx,session,candidate);
  if(items.length===200)continue;
  const state=await websiteSalesIrelandState(tx,session,candidate),workflow=state.current.workflow;
  if(!workflow)continue;
  items.push({...identity(session,candidate),opportunityId:workflow.id,workflowId:workflow.id,companyName:state.company.name,locationLabel:state.location.address,
   workflowVersion:workflow.version,evidenceDigest:workflow.evidenceDigest,status:workflow.status,statusKind:"stored",qualificationStatus:workflow.qualificationStatus,
   blockedReason:workflow.blockedReason,validUntil:workflow.validUntil,canWrite,canContact:false});
 }
 return{opportunities:items,opportunitiesHasMore:rows.length>200};
}
async function read(tx:TenantTransaction,session:AppSession,scope:SalesOperationsScope,resourceOnly=false):Promise<SalesOperationsRead>{
 await guard(tx,session,scope);const s=await websiteSalesIrelandState(tx,session,scope),bucket=await portfolio(tx,session,scope.projectId),used=bucket?await capacity(tx,session,bucket):{budget:0,minutes:0};
 const rows=await tx.query<AllocationRow>(`select ${allocationCols} from crm_website_sales_ops_allocations a join crm_website_sales_ops_portfolios p on p.workspace_id=a.workspace_id and p.id=a.portfolio_id where a.workspace_id=$1 and a.project_id=$2${resourceOnly?" and a.company_id=$3 and a.location_id=$4":""} order by case when a.status in('RESERVED','CLAIMED') then 0 else 1 end,a.created_at,a.id limit 25`,[session.workspaceId,scope.projectId,...(resourceOnly?[scope.companyId,scope.locationId]:[])]);
 for(const a of rows)await guard(tx,session,a);
 const policies=await tx.query<SalesOperationsRead["policies"][number]>(`select ${polcols} from crm_website_sales_ops_policies p where p.workspace_id=$1 and p.project_id=$2 order by p.created_at desc,p.id desc limit 25`,[session.workspaceId,scope.projectId]);
 const quotes=await tx.query<QuoteRow>(`select ${qcols} from crm_website_sales_ops_quotes where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 order by created_at desc,id desc limit 25`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);
 const financialEvidence=await tx.query<SalesOperationsRead["financialEvidence"][number]>(`select id,id as "sourceId",project_id as "projectId",company_id as "companyId",location_id as "locationId",workflow_id as "workflowId",source_hash as "canonicalSourceHash",source,created_at::text as "createdAt" from crm_website_sales_ops_financial_sources where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 order by created_at desc,id desc limit 25`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);
 const outcomes=await tx.query<SalesOperationsRead["outcomes"][number]>(`select id,project_id as "projectId",company_id as "companyId",location_id as "locationId",workflow_id as "workflowId",source_id as "sourceId",source_digest as "sourceDigest",event,created_at::text as "createdAt" from crm_website_sales_ops_outcomes where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 order by created_at desc,id desc limit 25`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);
 const improvements=resourceOnly?[]:await tx.query<SalesOperationsRead["improvements"][number]>(`select i.id,i.version,i.candidate_digest as "candidateDigest",i.candidate,i.created_at::text as "createdAt",d.id as "decisionId",case when exists(select 1 from crm_website_sales_ops_activations a where a.workspace_id=d.workspace_id and a.decision_id=d.id) then 'PROMOTED' when d.decision='APPROVED' then 'APPROVED' when d.decision='REJECTED' then 'REJECTED' else 'REVIEW_REQUIRED' end as status from crm_website_sales_ops_improvements i left join lateral(select * from crm_website_sales_ops_decisions x where x.workspace_id=i.workspace_id and x.improvement_id=i.id order by version desc limit 1)d on true where i.workspace_id=$1 and i.project_id=$2 order by i.created_at desc,i.id desc limit 25`,[session.workspaceId,scope.projectId]);
 const dialogInstalled=await tx.queryOne<{ok:boolean}>("select to_regclass('public.crm_website_sales_conversations') is not null as ok");
 const conversation=dialogInstalled?.ok?await readSalesConversationDescriptor(tx,session,scope):{version:0,language:"en" as const};
 const conversions=resourceOnly?[]:await tx.query<{workflowId:string;dealId:string|null;dealVersion:number|null;offerId:string|null;offerVersion:number|null;won:boolean;lost:boolean}>(`select a.workflow_id as "workflowId",d.id as "dealId",d.version as "dealVersion",o.id as "offerId",o.version as "offerVersion",coalesce(o.status='ACCEPTED' or exists(select 1 from projects cp join crm_pipeline_stages ps on ps.workspace_id=cp.workspace_id and ps.pipeline_id=cp.default_pipeline_id and ps.project_id=cp.id where cp.workspace_id=d.workspace_id and cp.id=d.project_id and ps.name=d.stage and ps.category='won'),false) as won,coalesce(o.status='REJECTED' or exists(select 1 from projects cp join crm_pipeline_stages ps on ps.workspace_id=cp.workspace_id and ps.pipeline_id=cp.default_pipeline_id and ps.project_id=cp.id where cp.workspace_id=d.workspace_id and cp.id=d.project_id and ps.name=d.stage and ps.category='lost'),false) as lost from crm_website_sales_ops_assignments a join crm_website_sales_workflows w on w.workspace_id=a.workspace_id and w.id=a.workflow_id left join deals d on d.workspace_id=w.workspace_id and d.id=w.deal_id left join crm_offers o on o.workspace_id=w.workspace_id and o.id=w.offer_draft_id where a.workspace_id=$1 and a.project_id=$2 order by a.id limit 501`,[session.workspaceId,scope.projectId]);
 const denominator=conversions.length,closedWonCount=conversions.filter(x=>x.won).length,closedLostCount=conversions.filter(x=>x.lost&&!x.won).length;
 const conversion={denominator,closedWonCount,closedLostCount,winRateBps:denominator?Number(BigInt(closedWonCount)*BigInt(10000)/BigInt(denominator)):null,source:"CANONICAL_CRM_STATE" as const,sourceDigest:crmPayloadDigest(conversions),profitPrediction:null};
 const inputs=resourceOnly?null:await cohort(tx,session,scope.projectId,1),summary=inputs?summarizeWebsiteSalesOutcomes(inputs,now()):null;
 const allowed=await tx.queryOne<{allowed:boolean}>("select crm_project_access($1,$2,true) as allowed",[session.workspaceId,scope.projectId]);
 const listed=resourceOnly?{opportunities:[],opportunitiesHasMore:false}:await opportunities(tx,session,scope.projectId);
 return{contractVersion:websiteSalesOperationsContract,source:"database",workspaceId:session.workspaceId,...scopeOf(scope),...listed,
  projection:resourceOnly?"RESOURCE":"PORTFOLIO",portfolio:bucket&&!resourceOnly?{...bucket,budgetMinor:n(bucket.budgetMinor),capacityMinutes:n(bucket.capacityMinutes),allocatedBudgetMinor:used.budget,allocatedCapacityMinutes:used.minutes}:null,
  allocations:rows.map(row=>{const a={...row} as Partial<AllocationRow>;delete a.leaseToken;delete a.current;delete a.sealedDigest;return{...a,amountMinor:n(row.amountMinor),capacityMinutes:n(row.capacityMinutes),expectedAllocationVersion:row.status==="CLAIMED"?row.version-1:row.version} as SalesOperationsRead["allocations"][number];}),policies,quotes:quotes as unknown as SalesOperationsRead["quotes"],financialEvidence,outcomes,improvements,conversation,cohort:summary?{...summary,conversion}:null,workflow:s.current.workflow,
  canApprovePolicies:!session.serviceIdentity&&!!(await tx.queryOne<{ok:boolean}>("select crm_sales_ops_owner($1) as ok",[session.workspaceId]))?.ok,canWrite:!!allowed?.allowed&&session.permissions.includes("crm:write")&&session.productPermissions.includes("pipeline:write"),canContact:false};
}
export async function readSalesOperations(session:AppSession,scope:SalesOperationsScope,options:TenantTransactionOptions={},resourceOnly=false){
 websiteSalesActorAuthority(session,scope,"read","autonomy");return withCrmRead(session,(tx,fresh)=>read(tx,fresh,scopeSchema.parse(scope),resourceOnly),options);
}
export async function executeSalesOperationsCommand(session:AppSession,raw:SalesOperationsCommand,options:TenantTransactionOptions={}){
 const c=parseSalesOperationsCommand(raw),command=salesOperationsCommandInput(session,c);
 return withCrmRead(session,async(outer,fresh)=>{
  await guard(outer,fresh,c,true);await projectLock(outer,fresh,c.projectId);if(ownerOps.has(c.operation))await owner(outer,fresh);
  const result=await executeCrmCommand(fresh,command,async(tx,context):Promise<SalesOperationsEffect>=>{
   let effect:Omit<SalesOperationsEffect,"workspaceId"|"projectId"|"companyId"|"locationId">;
   switch(c.operation){
    case"configure_portfolio":effect=await configure(tx,context.session,c,context.commandId);break;
    case"plan_portfolio":effect=await plan(tx,context.session,c);break;
    case"claim_allocation":effect=await claim(tx,context.session,c);break;
    case"settle_allocation":effect=await settle(tx,context.session,c);break;
    case"register_price_rule":effect=await registerPrice(tx,context.session,c,context.commandId);break;
    case"propose_price":effect=await proposePrice(tx,context.session,c);break;
    case"apply_quote":effect=await applyQuote(tx,context.session,c,options);break;
    case"register_financial_evidence":effect=await registerEvidence(tx,context.session,c,context.commandId);break;
    case"record_outcome":effect=await recordOutcome(tx,context.session,c);break;
    case"propose_improvement":effect=await proposeImprovement(tx,context.session,c);break;
    case"review_improvement":effect=await reviewImprovement(tx,context.session,c,context.commandId);break;
    case"promote_improvement":effect=await promoteImprovement(tx,context.session,c);break;
   }
   await guard(tx,context.session,c,true);return{...effect,workspaceId:context.session.workspaceId,projectId:c.projectId,companyId:c.companyId,locationId:c.locationId,canContact:false};
  },options);
  // Stored replay skips the effect callback: refresh scope and all referenced resources before returning it.
  const currentData=await read(outer,fresh,c,true);return{...result,contractVersion:websiteSalesOperationsContract,persisted:true as const,correlationId:c.correlationId,currentData};
 },options);
}
export async function reconcileSalesOperationsCommand(session:AppSession,raw:SalesOperationsCommand,options:TenantTransactionOptions={}){
 const c=parseSalesOperationsCommand(raw),command=salesOperationsCommandInput(session,c);
 return withCrmRead(session,async(tx,fresh)=>{await guard(tx,fresh,c);const receipt=await reconcileCrmCommand<SalesOperationsEffect>(fresh,command,options);return receipt.status==="COMMITTED"?{...receipt,currentData:await read(tx,fresh,c,true)}:receipt;},options);
}
