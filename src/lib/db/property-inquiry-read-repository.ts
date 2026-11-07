import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, type TenantTransaction } from "@/lib/crm-command";
import type { PropertyInquiryState } from "@/lib/property-inquiries";
export async function loadPropertyInquiries(tx:TenantTransaction,session:AppSession,projectId:string|null):Promise<PropertyInquiryState>{
  if(projectId)await assertProjectGrant(tx,session,assertCrmUuid(projectId),false);
  const row=await tx.queryOne<{data:PropertyInquiryState}>(`with visible as (
    select i.id,i.property_id as "propertyId",p.title as "propertyTitle",l.id as "leadId",l.intent as "leadLabel",c.name as "contactName",u.unit_number as "unitNumber",i.source_channel as source,i.campaign,i.created_at as "createdAt"
    from property_inquiries i join seller_listings p on p.id=i.property_id and p.workspace_id=i.workspace_id and p.project_id is not distinct from i.project_id
    join leads l on l.id=i.lead_id and l.workspace_id=i.workspace_id and l.project_id is not distinct from i.project_id
    left join contacts c on c.id=i.contact_id and c.workspace_id=i.workspace_id and c.project_id is not distinct from i.project_id
    left join property_units u on u.id=i.unit_id and u.workspace_id=i.workspace_id and u.project_id is not distinct from i.project_id
    where i.workspace_id=$1::uuid and ($2::uuid is null or i.project_id=$2::uuid)
  ), counts as (select "propertyId",count(*)::integer as count from visible group by "propertyId"), recent as (select * from visible order by "createdAt" desc,id desc limit 100)
  select jsonb_build_object('counts',coalesce((select jsonb_agg(counts) from counts),'[]'),'items',coalesce((select jsonb_agg(recent) from recent),'[]')) as data`,[session.workspaceId,projectId]);
  return row?.data??{counts:[],items:[]};
}
