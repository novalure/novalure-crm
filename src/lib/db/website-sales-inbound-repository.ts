import type { AppSession } from "../auth/session";
import { CrmCommandError, type TenantTransaction } from "../crm-command";

type Scope = { projectId: string; companyId: string; locationId: string };
export type WebsiteSalesInboundChain = { leadId: string; leadVersion: number; dealId: string | null };
function fail(code: string): never { throw new CrmCommandError(code, code, 409); }
/** Reuse the actual Studio-form lineage. Do not create a second acquisition lead for an existing enquiry. */
export async function lockWebsiteSalesInboundDeal(tx: TenantTransaction, session: AppSession, scope: Scope, contactId: string): Promise<WebsiteSalesInboundChain | null> {
  const leads = await tx.query<{ id: string; version: number; status: string }>(`select l.id,l.version,l.status from leads l where l.workspace_id=$1 and l.project_id=$2 and l.contact_id=$3
    and l.division='WEB_DESIGN' and l.data_classification='NOVALURE_INTERNAL' and l.data_purpose='crm_sales'
    and (l.source='Novalure Studio Form' or l.metadata ? 'studioEnquiry')
    and not exists(select 1 from crm_website_sales_workflows w where w.workspace_id=l.workspace_id and w.lead_id=l.id) order by l.id limit 2`,
  [session.workspaceId, scope.projectId, contactId]);
  if (leads.length > 1) fail("STUDIO_INBOUND_AMBIGUOUS");
  const lead = leads[0]; if (!lead) return null;
  if (["won", "lost", "disqualified", "gewonnen", "verloren", "abgelehnt", "geschlossen"].includes(lead.status.toLowerCase())) fail("STUDIO_INBOUND_TERMINAL");
  // Existing offers lock Deal → Contact → Lead; retain that order.
  const deals = await tx.query<{ id: string; organizationId: string | null; closedAt: string | null; terminal: boolean }>(`select d.id,d.organization_id as "organizationId",d.closed_at as "closedAt",
    exists(select 1 from crm_pipeline_stages s where s.workspace_id=d.workspace_id and s.project_id=d.project_id and s.name=d.stage and s.category in('won','lost','disqualified')) as terminal
    from deals d where d.workspace_id=$1 and d.project_id=$2 and d.contact_id=$3 and d.lead_id=$4 and d.division='WEB_DESIGN'
      and d.data_classification='NOVALURE_INTERNAL' and d.data_purpose='crm_sales' order by d.id limit 2 for update of d`, [session.workspaceId, scope.projectId, contactId, lead.id]);
  if (deals.length > 1) fail("STUDIO_INBOUND_AMBIGUOUS");
  const deal = deals[0];
  if (deal && (deal.organizationId !== null && deal.organizationId !== scope.companyId || deal.closedAt || deal.terminal)) fail("STUDIO_INBOUND_DEAL_CONFLICT");
  return { leadId: lead.id, leadVersion: Number(lead.version), dealId: deal?.id ?? null };
}
export async function attachWebsiteSalesInbound(tx: TenantTransaction, session: AppSession, scope: Scope, contactId: string, chain: WebsiteSalesInboundChain, provenance: string) {
  const lead = await tx.queryOne<{ id: string }>(`select l.id from leads l where l.workspace_id=$1 and l.project_id=$2 and l.id=$3 and l.contact_id=$4 and l.version=$5
    and not exists(select 1 from crm_website_sales_workflows w where w.workspace_id=l.workspace_id and w.lead_id=l.id) for update of l`,
  [session.workspaceId, scope.projectId, chain.leadId, contactId, chain.leadVersion]);
  if (!lead) fail("STUDIO_INBOUND_CHANGED");
  await tx.execute("update leads set metadata=metadata || $3::jsonb,version=version+1,updated_at=now() where workspace_id=$1 and id=$2", [session.workspaceId, chain.leadId, provenance]);
  if (chain.dealId) await tx.execute("update deals set organization_id=$3,metadata=metadata || $4::jsonb,version=version+1,updated_at=now() where workspace_id=$1 and id=$2", [session.workspaceId, chain.dealId, scope.companyId, provenance]);
}
