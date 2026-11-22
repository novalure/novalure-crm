import 'server-only';
import type {TenantTransaction} from './tenant-client';
import {commercePolicySchema,commerceSubscriptionTermsSchema} from '../website-sales-commerce-types';
import type {WebsiteSalesCommerceSourceEvent as Event} from '../website-sales-commerce-types';
import {CANONICAL_WEBSITE_SALES_CATALOG} from '../website-sales-enablement-types';
import {commerceDigest,resolveWebsiteSalesCommerceSubscription} from '../website-sales-commerce-domain';
import {commerceFail as fail,commerceRows,commerceParams,type CommerceScope} from './website-sales-commerce-storage';
export async function currentAuthoritativeWebsiteSalesCare(tx:TenantTransaction,s:{workspaceId:string},b:CommerceScope,offerId:string){
 const installed=await tx.queryOne<{ok:boolean}>("select to_regclass('public.crm_website_sales_commerce_sources') is not null as ok");if(!installed?.ok)fail('CARE_RENEWAL_REVIEW_ONLY');
 const rows=await commerceRows(tx,s,b),contracts=rows.filter(r=>r.kind==='CONTRACT'&&(r.payload.offerRef as {id?:string})?.id===offerId);
 const terms=rows.find(r=>r.kind==='SUBSCRIPTION_TERMS'&&contracts.some(c=>commerceDigest({id:c.entityId,version:c.version,digest:c.digest})===commerceDigest(r.payload.contractRef)));
 if(!terms)fail('CARE_AUTHORITATIVE_SUBSCRIPTION_REQUIRED');
 const events=(await tx.query<{payload:Event}>(`select payload from crm_website_sales_commerce_sources where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by received_at limit 1001`,commerceParams(s,b))).map(r=>r.payload);if(events.length>1000)fail('COMMERCE_FINANCIAL_HISTORY_LIMITED');
 const parsed=commerceSubscriptionTermsSchema.parse(terms.payload),current=resolveWebsiteSalesCommerceSubscription({identity:{workspaceId:s.workspaceId,projectId:b.projectId,companyId:b.companyId,locationId:b.locationId},workflowId:b.workflowId,events,terms:parsed},new Date().toISOString());
 if(current.status!=='READY'||!current.value)fail(current.reasons[0]??'CARE_ACTIVE_SUBSCRIPTION_REQUIRED');return current.value;
}
export function websiteSalesCommerceTermMonths(original:string,startAt:string,endAt:string){
 const root=new Date(original),start=new Date(startAt),end=new Date(endAt);
 const offset=(date:Date)=>(date.getUTCFullYear()-root.getUTCFullYear())*12+date.getUTCMonth()-root.getUTCMonth();
 const anniversary=(months:number)=>{const date=new Date(root);const day=root.getUTCDate();date.setUTCDate(1);date.setUTCMonth(root.getUTCMonth()+months);const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));return date.toISOString();};
 const first=offset(start),last=offset(end);if(first<0||last-first<1||last-first>600||anniversary(first)!==start.toISOString()||anniversary(last)!==end.toISOString())fail('CARE_FINITE_COMPLETE_MONTH_TERM_REQUIRED');
 return{firstServiceMonth:first+1,months:last-first};
}
export async function assertWebsiteSalesCareContractTerm(tx:TenantTransaction,s:{workspaceId:string},b:CommerceScope,offerId:string,raw:unknown){
 const linked=await tx.queryOne<{proposalId:string}>(`select payload->>'careProposalId' as "proposalId" from crm_website_sales_enablement_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and kind='CARE_OFFER' and payload->>'offerId'=$6 order by created_at desc limit 1`,[...commerceParams(s,b),offerId]);if(!linked)return;
 const p=commercePolicySchema.parse(raw),term=p.contractTerm;if(!term)fail('CARE_FINITE_FULL_CONTRACT_TERM_REQUIRED');
 const proposal=await tx.queryOne<{payload:{planKey:keyof typeof CANONICAL_WEBSITE_SALES_CATALOG.care;renewal:{canonicalAcceptedCareOfferId:string;serviceStartAt:string}|null}}>(`select payload from crm_website_sales_enablement_records where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and entity_id=$6 and kind='CARE_PROPOSAL' order by version desc limit 1`,[...commerceParams(s,b),linked.proposalId]);if(!proposal)fail('CURRENT_CARE_PROPOSAL_REQUIRED');
 const plan=CANONICAL_WEBSITE_SALES_CATALOG.care[proposal.payload.planKey];if(!plan)fail('CARE_CATALOG_REQUIRED');
 let original=term.startAt;if(proposal.payload.renewal){const source=await currentAuthoritativeWebsiteSalesCare(tx,s,b,proposal.payload.renewal.canonicalAcceptedCareOfferId);original=source.payload.originalServiceStartAt;if(proposal.payload.renewal.serviceStartAt!==original)fail('CARE_ORIGINAL_SERVICE_START_CHANGED');}
 const {firstServiceMonth:first,months}=websiteSalesCommerceTermMonths(original,term.startAt,term.endAt);let total=BigInt(0);for(let offset=0;offset<months;offset++){const month=first+offset,bracket=plan.find(r=>month>=r.fromMonth&&(r.throughMonth===null||month<=r.throughMonth));if(!bracket)fail('CARE_CATALOG_PERIOD_REQUIRED');total+=BigInt(bracket.netMonthlyMinor);}
 if(total!==BigInt(term.fullNetMinor)||term.fullNetMinor!==p.financialSnapshot.netMinor)fail('CARE_FULL_CANONICAL_OBLIGATION_REQUIRED');
}
