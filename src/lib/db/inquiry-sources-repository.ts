import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, type TenantTransaction } from "@/lib/crm-command";
import type { InquirySourceReport } from "@/lib/inquiry-sources";

export async function loadInquirySources(tx:TenantTransaction,session:AppSession,projectId:string|null,days:30|90):Promise<InquirySourceReport>{
  if(projectId)await assertProjectGrant(tx,session,assertCrmUuid(projectId),false);
  const installed=await tx.queryOne<{installed:boolean}>(`select to_regclass('public.web_expose_links') is not null as installed`);
  const sources=await tx.query<InquirySourceReport["sources"][number]>(`with attributed as (
    select l.id,l.status,
      ${installed?.installed?`case when link.id is not null and link.intended_lead_id is not null then 'expose_personal' when link.id is not null then 'expose_channel' else 'crm' end`:`'crm'::text`} as kind,
      ${installed?.installed?`case when link.id is not null and link.intended_lead_id is not null then 'Persönlicher Exposé-Link' when link.id is not null then link.label else coalesce(nullif(trim(l.source),''),'Nicht erfasst') end`:`coalesce(nullif(trim(l.source),''),'Nicht erfasst')`} as label
    from leads l ${installed?.installed?`left join web_expose_links link on link.workspace_id=l.workspace_id and link.id::text=l.metadata->>'webExposeLinkId'`:``}
    where l.workspace_id=$1::uuid and ($2::uuid is null or l.project_id=$2::uuid) and l.received_at>=clock_timestamp()-make_interval(days=>$3::integer)
      and coalesce(l.metadata->'onboardingExample'->>'synthetic','false')<>'true'
      and coalesce(l.metadata->'websiteSales'->>'syntheticTest','false')<>'true'
  ) select kind,label,count(*)::integer as leads,count(*) filter(where status in('Qualifiziert','Übergabe'))::integer as qualified,count(*) filter(where status='Archiviert')::integer as archived
    from attributed group by kind,label order by count(*) desc,label limit 100`,[session.workspaceId,projectId,days]);
  return {asOf:new Date().toISOString(),days,projectId,sources};
}
