import type {VerifiedResendEvent,ProviderDeliveryKind} from '@/lib/resend-webhooks';
import {queryOne} from '@/lib/db/client';
import type {TenantTransaction} from '@/lib/crm-command';
export type ProviderDeliveryState='sent'|'delivered'|'delayed'|'failed'|'bounced'|'complained'|'suppressed';
type PublicQuery=(sql:string,params:unknown[])=>Promise<{result:unknown}|null>;
export async function recordVerifiedResendEvent(event:VerifiedResendEvent,query:PublicQuery=(sql,params)=>queryOne<{result:unknown}>(sql,params)){
 const row=await query('select crm_record_resend_delivery_event($1::jsonb) as result',[JSON.stringify(event)]);return row?.result as {status:'recorded'|'duplicate'|'ignored'|'conflict'}|null;
}
export async function readProviderDeliveryState(tx:TenantTransaction,workspaceId:string,deliveryId:string,kind:ProviderDeliveryKind):Promise<ProviderDeliveryState|null>{
 return(await readProviderDeliveryStates(tx,workspaceId,[{id:deliveryId,kind}])).get(kind+':'+deliveryId)??null;
}
export async function readProviderDeliveryStates(tx:TenantTransaction,workspaceId:string,targets:{id:string;kind:ProviderDeliveryKind}[]){
 const states=new Map<string,ProviderDeliveryState>();if(!targets.length)return states;
 const installed=await tx.queryOne<{ready:boolean}>("select to_regclass('public.crm_provider_delivery_events') is not null as ready");if(!installed?.ready)return states;
 const rows=await tx.query<{id:string;kind:string;state:ProviderDeliveryState}>(`select distinct on(delivery_kind,delivery_id) delivery_id as id,delivery_kind as kind,case event_type when 'email.complained' then 'complained' when 'email.bounced' then 'bounced' when 'email.suppressed' then 'suppressed' when 'email.failed' then 'failed' when 'email.delivered' then 'delivered' when 'email.delivery_delayed' then 'delayed' else 'sent' end as state from crm_provider_delivery_events where workspace_id=$1::uuid and delivery_id=any($2::uuid[]) and delivery_kind=any($3::text[]) order by delivery_kind,delivery_id,case event_type when 'email.complained' then 7 when 'email.bounced' then 6 when 'email.suppressed' then 5 when 'email.failed' then 4 when 'email.delivered' then 3 when 'email.delivery_delayed' then 2 else 1 end desc,occurred_at desc`,[workspaceId,targets.map(target=>target.id),[...new Set(targets.map(target=>target.kind))]]);
 const allowed=new Set(targets.map(target=>target.kind+':'+target.id));for(const row of rows)if(allowed.has(row.kind+':'+row.id))states.set(row.kind+':'+row.id,row.state);return states;
}
