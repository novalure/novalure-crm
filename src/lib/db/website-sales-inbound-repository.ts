import { randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { CrmCommandError, type TenantTransaction } from "../crm-command";

type Scope = { projectId: string; companyId: string; locationId: string };
type InboundChain = { leadId: string; leadVersion: number; dealId: string | null };
type QualifiedDeal = { name: string; stage: string; nextAction: string };
function fail(code: string): never { throw new CrmCommandError(code, code, 409); }

/** Bind the original Studio Lead and any original Deal without substituting another record. */
export async function lockWebsiteSalesInboundDeal(tx: TenantTransaction, session: AppSession, scope: Scope,
  contactId: string, leadId: string, submissionDealId: string | null): Promise<InboundChain> {
  const scopeParameters = [session.workspaceId, scope.projectId, contactId, leadId];
  const lead = await tx.queryOne<{ version: number }>(`select l.version from leads l
    join projects p on p.workspace_id=l.workspace_id and p.id=l.project_id and p.division=l.division
    where l.workspace_id=$1 and l.project_id=$2 and l.contact_id=$3 and l.id=$4
      and l.data_classification='NOVALURE_INTERNAL' and l.data_purpose='crm_sales'
      and (l.source='Novalure Studio Form' or l.metadata ? 'studioEnquiry')
      and lower(l.status) not in ('won','lost','disqualified','gewonnen','verloren','abgelehnt','geschlossen')`, scopeParameters);
  if (!lead) fail("STUDIO_INBOUND_LEAD_UNAVAILABLE");

  const deals = await tx.query<{ id: string; organizationId: string | null; eligible: boolean; terminal: boolean }>(`select d.id,d.organization_id as "organizationId",
    (d.project_id=$2 and d.contact_id=$3 and d.division=p.division and d.data_classification='NOVALURE_INTERNAL'
      and d.data_purpose='crm_sales') as eligible,
    (d.closed_at is not null or exists(select 1 from crm_pipeline_stages s where s.workspace_id=d.workspace_id
      and s.project_id=d.project_id and s.name=d.stage and s.category in ('won','lost','disqualified'))) as terminal
    from deals d left join projects p on p.workspace_id=d.workspace_id and p.id=d.project_id
    where d.workspace_id=$1 and d.lead_id=$4 order by d.id limit 2 for update of d`, scopeParameters);
  if (submissionDealId === null) {
    if (deals.length) fail("STUDIO_INBOUND_DEAL_CONFLICT");
    return { leadId, leadVersion: Number(lead.version), dealId: null };
  }
  if (deals.length !== 1) fail(deals.length ? "STUDIO_INBOUND_AMBIGUOUS" : "STUDIO_INBOUND_DEAL_UNAVAILABLE");
  const deal = deals[0]!;
  if (deal.id !== submissionDealId || !deal.eligible || deal.terminal ||
    (deal.organizationId !== null && deal.organizationId !== scope.companyId)) {
    fail("STUDIO_INBOUND_DEAL_CONFLICT");
  }
  return { leadId, leadVersion: Number(lead.version), dealId: deal.id };
}

export async function attachWebsiteSalesInbound(tx: TenantTransaction, session: AppSession, scope: Scope,
  contactId: string, chain: InboundChain, provenance: string, qualifiedDeal: QualifiedDeal): Promise<{ dealId: string }> {
  // The caller holds any original Deal and the canonical Contact locks. The
  // optimistic Lead claim also serializes qualifications for different locations.
  const lead = await tx.queryOne(`update leads l set metadata=l.metadata || $6::jsonb,version=l.version+1,updated_at=now()
    where l.workspace_id=$1 and l.project_id=$2 and l.id=$3 and l.contact_id=$4 and l.version=$5
      and not exists(select 1 from crm_website_sales_workflows w where w.workspace_id=l.workspace_id and w.lead_id=l.id)
    returning l.id`, [session.workspaceId, scope.projectId, chain.leadId, contactId, chain.leadVersion, provenance]);
  if (!lead) fail("STUDIO_INBOUND_CHANGED");

  // Preserve Deal → Contact → Lead lock order. The stronger Lead lock also
  // orders FK-linked Deal inserts before this final claim check or after commit.
  await tx.query("select id from leads where workspace_id=$1 and id=$2 for update", [session.workspaceId, chain.leadId]);
  const claimedDeals = await tx.query<{ id: string }>(`select id from deals
    where workspace_id=$1 and lead_id=$2 order by id limit 2`, [session.workspaceId, chain.leadId]);
  if (chain.dealId === null ? claimedDeals.length !== 0 : claimedDeals.length !== 1 || claimedDeals[0]?.id !== chain.dealId)
    fail("STUDIO_INBOUND_DEAL_CONFLICT");

  if (chain.dealId === null) {
    // Recheck after claiming the Lead. Never adopt a Deal created outside this
    // accepted intake, and never rewrite the original NULL submission link.
    const deal = await tx.queryOne<{ id: string }>(`insert into deals
      (id,workspace_id,project_id,contact_id,organization_id,owner_user_id,lead_id,division,name,stage,source,next_action,metadata)
      select $1,$2,p.id,$4,$5,$6,$7,p.division,$8,$9,'Novalure Studio Form',$10,$11::jsonb
      from projects p where p.workspace_id=$2 and p.id=$3 and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales'
        and not exists(select 1 from deals d where d.workspace_id=$2 and d.lead_id=$7)
      returning id`, [randomUUID(), session.workspaceId, scope.projectId, contactId, scope.companyId, session.userId, chain.leadId,
      qualifiedDeal.name, qualifiedDeal.stage, qualifiedDeal.nextAction, provenance]);
    if (!deal) fail("STUDIO_INBOUND_DEAL_CONFLICT");
    return { dealId: deal.id };
  }

  const deal = await tx.queryOne(`update deals set organization_id=$6,metadata=metadata || $7::jsonb,version=version+1,updated_at=now()
    where workspace_id=$1 and project_id=$2 and id=$3 and contact_id=$4 and lead_id=$5
      and (organization_id is null or organization_id=$6) returning id`,
  [session.workspaceId, scope.projectId, chain.dealId, contactId, chain.leadId, scope.companyId, provenance]);
  if (!deal) fail("STUDIO_INBOUND_CHANGED");
  return { dealId: chain.dealId };
}
