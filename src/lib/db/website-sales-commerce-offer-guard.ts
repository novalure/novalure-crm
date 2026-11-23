import 'server-only';
import type {AppSession} from '../auth/session';
import {CrmCommandError,type TenantTransaction} from '../crm-command';
function commerceFail(code:string):never{throw new CrmCommandError(code,code,409);}
export async function lockWebsiteSalesCommerceOffer(tx:TenantTransaction,session:AppSession,offerId:string|undefined,operation:string){
 if(!offerId||!(await tx.queryOne<{installed:boolean}>("select to_regclass('public.crm_website_sales_commerce_jobs') is not null as installed"))?.installed)return;
 const linked=await tx.queryOne<{workflowId:string;projectId:string;locationId:string;dealId:string}>(`select w.id as "workflowId",w.project_id as "projectId",w.location_id as "locationId",o.deal_id as "dealId" from crm_offers o join crm_website_sales_workflows w on w.workspace_id=o.workspace_id and w.project_id=o.project_id and w.company_id=o.organization_id where o.workspace_id=$1 and o.id=$2 and(w.offer_draft_id=o.id or exists(select 1 from crm_website_sales_enablement_records e where e.workspace_id=w.workspace_id and e.workflow_id=w.id and e.kind='CARE_OFFER' and e.payload->>'offerId'=o.id::text))`,[session.workspaceId,offerId]);
 if(!linked)return;
 await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`website-sales-location:${session.workspaceId}:${linked.locationId}`]);
 await tx.query('select id from crm_website_sales_workflows where workspace_id=$1 and id=$2 for update',[session.workspaceId,linked.workflowId]);
 await tx.query('select id from deals where workspace_id=$1 and id=$2 for update',[session.workspaceId,linked.dealId]);
 if(await tx.queryOne("select id from crm_website_sales_commerce_jobs where workspace_id=$1 and workflow_id=$2 and offer_id=$3 and status in('CLAIMED','UNKNOWN')",[session.workspaceId,linked.workflowId,offerId]))commerceFail('COMMERCE_DELIVERY_OUTCOME_UNKNOWN');
 if(operation==='revise'&&await tx.queryOne(`select s.id from crm_website_sales_commerce_sources s join crm_website_sales_commerce_records r on r.workspace_id=s.workspace_id and r.workflow_id=s.workflow_id and r.entity_id=(s.payload->'payload'->'contractRef'->>'id')::uuid and r.version=(s.payload->'payload'->'contractRef'->>'version')::integer where s.workspace_id=$1 and s.workflow_id=$2 and s.kind='SIGNATURE' and s.payload->'payload'->>'status'='SIGNED' and r.kind='CONTRACT' and r.payload->'offerRef'->>'id'=$3`,[session.workspaceId,linked.workflowId,offerId]))commerceFail('BINDING_CONTRACT_REVIEW_REQUIRED');
}
