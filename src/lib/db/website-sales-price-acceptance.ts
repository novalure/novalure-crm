import type {TenantTransaction} from "../crm-command";
export type SalesAcceptancePrice={acceptedQuoteId:string|null;acceptedOfferId:string|null;acceptedOfferVersion:number|null;acceptedOfferRevision:number|null;acceptedOfferDigest:string|null};
export async function readSalesAcceptancePrice(tx:TenantTransaction,workspaceId:string,workflowId:string):Promise<SalesAcceptancePrice|null>{
 const available=await tx.queryOne<{ok:boolean}>("select to_regclass('public.crm_website_sales_ops_quotes') is not null as ok");if(!available?.ok)return null;
 const row=await tx.queryOne<SalesAcceptancePrice>(`select (select q.id from crm_website_sales_ops_quotes q where q.workspace_id=o.workspace_id and q.workflow_id=w.id and q.status='APPLIED' and q.offer_id=o.id and q.offer_version=o.version and q.offer_revision=o.revision and q.offer_digest=r.content_digest order by applied_at desc,id desc limit 1) as "acceptedQuoteId",o.id as "acceptedOfferId",o.version as "acceptedOfferVersion",o.revision as "acceptedOfferRevision",r.content_digest as "acceptedOfferDigest" from crm_website_sales_workflows w join crm_offers o on o.workspace_id=w.workspace_id and o.id=w.offer_draft_id join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision where w.workspace_id=$1 and w.id=$2`,[workspaceId,workflowId]);
 return row??{acceptedQuoteId:null,acceptedOfferId:null,acceptedOfferVersion:null,acceptedOfferRevision:null,acceptedOfferDigest:null};
}
export function salesAcceptancePriceMatches(record:Record<string,unknown>,current:SalesAcceptancePrice|null){
 if(current===null)return true;
 return(record.accepted_quote_id??null)===current.acceptedQuoteId&&(record.accepted_offer_id??null)===current.acceptedOfferId&&Number(record.accepted_offer_version??0)===Number(current.acceptedOfferVersion??0)&&Number(record.accepted_offer_revision??0)===Number(current.acceptedOfferRevision??0)&&(record.accepted_offer_digest??null)===current.acceptedOfferDigest;
}
