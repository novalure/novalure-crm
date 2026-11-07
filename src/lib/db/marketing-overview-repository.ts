import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertProjectGrant, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import { getWorkspaceEnabledModules, hasProductCapability, isWorkspaceModuleEnabled } from "@/lib/product-model";
import { getNewsletterProviderStatus } from "@/lib/integrations/resend";
import type { MarketingOverview } from "@/lib/marketing-hub";

/** Reads original rows under the caller's current membership and RLS. No private inbox data. */
export async function readMarketingOverview(session: AppSession, projectId: string | null, options: TenantTransactionOptions = {}): Promise<MarketingOverview> {
  return withCrmRead(session, async (tx, fresh) => {
    if (projectId) await assertProjectGrant(tx, fresh, projectId);
    const workspace = await tx.queryOne<{ name: string; setup: Record<string, unknown> }>("select name,setup_state as setup from workspaces where id=$1::uuid", [fresh.workspaceId]);
    const enabled = getWorkspaceEnabledModules({ workspaceId: fresh.workspaceId, workspaceName: workspace?.name ?? fresh.workspaceName, setupState: workspace?.setup });
    const modules: MarketingOverview["modules"] = {
      newsletter: isWorkspaceModuleEnabled(enabled, "newsletter"), flows: isWorkspaceModuleEnabled(enabled, "tasks"),
      funnels: isWorkspaceModuleEnabled(enabled, "funnels"), properties: isWorkspaceModuleEnabled(enabled, "properties"),
      contacts: isWorkspaceModuleEnabled(enabled, "contacts"), communication: isWorkspaceModuleEnabled(enabled, "communication"),
      reports: isWorkspaceModuleEnabled(enabled, "analytics") && hasProductCapability(fresh.productRole, "analytics:read"),
    };
    const result: MarketingOverview = { workspaceId: fresh.workspaceId, projectId, asOf: new Date().toISOString(), modules,
      counts: { campaigns: null, audiences: null, mailTemplates: null, mailings: null, approvalNeeded: null, planned: null, flows: null, activeFlows: null, funnels: null, activeFunnels: null, publications: null },
      review: [], reviewLimited: false, newsletterProviderConfigured: getNewsletterProviderStatus().configured };
    const installed = await tx.queryOne<{ newsletter: boolean; flows: boolean; schedules: boolean; exposes: boolean }>(`select to_regclass('public.crm_newsletter_drafts') is not null as newsletter,to_regclass('public.crm_automations') is not null as flows,to_regclass('public.crm_newsletter_schedules') is not null as schedules,to_regclass('public.web_expose_versions') is not null as exposes`);
    const scope = [fresh.workspaceId, projectId];
    const marketingInstalled = await tx.queryOne<{ ready: boolean }>("select to_regclass('public.crm_marketing_initiatives') is not null as ready");
    if (marketingInstalled?.ready) {
      const campaigns = await tx.queryOne<{ count: number }>("select count(*)::integer as count from crm_marketing_initiatives where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid)", scope);
      result.counts.campaigns = campaigns?.count ?? 0;
      if (modules.contacts) {
        const audiences = await tx.queryOne<{ count: number }>("select count(*)::integer as count from newsletter_segments where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid)", scope);
        result.counts.audiences = audiences?.count ?? 0;
      }
      if (modules.newsletter) {
        const templates = await tx.queryOne<{ count: number }>("select count(*)::integer as count from crm_marketing_templates where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid)", scope);
        result.counts.mailTemplates = templates?.count ?? 0;
      }
    }
    if (modules.newsletter && installed?.newsletter) {
      const counts = await tx.queryOne<{ mailings: number; approvalNeeded: number }>(`select count(*)::integer as mailings,count(*) filter(where d.approved_revision is distinct from d.revision and c.status<>'gesendet')::integer as "approvalNeeded" from crm_newsletter_drafts d join newsletter_campaigns c on c.workspace_id=d.workspace_id and c.id=d.campaign_id where d.workspace_id=$1::uuid and ($2::uuid is null or d.project_id=$2::uuid)`, scope);
      if (counts) Object.assign(result.counts, counts);
      const reviews = await tx.query<{ id: string; projectId: string; title: string; reason: "approval" | "delivery_unknown" }>(`select d.campaign_id as id,d.project_id as "projectId",c.name as title,case when exists(select 1 from crm_newsletter_deliveries x where x.workspace_id=d.workspace_id and x.campaign_id=d.campaign_id and x.status='uncertain') then 'delivery_unknown' else 'approval' end as reason from crm_newsletter_drafts d join newsletter_campaigns c on c.workspace_id=d.workspace_id and c.id=d.campaign_id where d.workspace_id=$1::uuid and ($2::uuid is null or d.project_id=$2::uuid) and ((d.approved_revision is distinct from d.revision and c.status<>'gesendet') or exists(select 1 from crm_newsletter_deliveries x where x.workspace_id=d.workspace_id and x.campaign_id=d.campaign_id and x.status='uncertain')) order by d.updated_at desc,d.campaign_id limit 21`, scope);
      result.reviewLimited ||= reviews.length > 20;
      for (const row of reviews.slice(0, 20)) result.review.push({ key: `newsletter:${row.id}`, title: row.title, reason: row.reason, target: { kind: "newsletter", id: row.id, projectId: row.projectId } });
      if (installed.schedules) {
        const planned = await tx.queryOne<{ count: number }>(`select count(*)::integer as count from crm_newsletter_schedules where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and status in('queued','running')`, scope);
        result.counts.planned = planned?.count ?? 0;
        const blocked = await tx.query<{ id: string; projectId: string; title: string }>(`select s.campaign_id as id,s.project_id as "projectId",c.name as title from crm_newsletter_schedules s join newsletter_campaigns c on c.workspace_id=s.workspace_id and c.id=s.campaign_id where s.workspace_id=$1::uuid and ($2::uuid is null or s.project_id=$2::uuid) and s.status='blocked' order by s.updated_at desc,s.id limit 21`, scope);
        result.reviewLimited ||= blocked.length > 20;
        for (const row of blocked.slice(0, 20)) result.review.push({ key: `schedule:${row.id}`, title: row.title, reason: "schedule_blocked", target: { kind: "newsletter", id: row.id, projectId: row.projectId } });
      }
    }
    if (modules.flows && installed?.flows) {
      const counts = await tx.queryOne<{ flows: number; activeFlows: number }>(`select count(*)::integer as flows,count(*) filter(where status='active')::integer as "activeFlows" from crm_automations where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid)`, scope);
      if (counts) Object.assign(result.counts, counts);
      const reviews = await tx.query<{ id: string; projectId: string | null; title: string }>(`select a.id,a.project_id as "projectId",a.name as title from crm_automations a where a.workspace_id=$1::uuid and ($2::uuid is null or a.project_id=$2::uuid) and exists(select 1 from crm_automation_enrollments e where e.workspace_id=a.workspace_id and e.automation_id=a.id and e.status in('review','blocked','failed')) order by a.updated_at desc,a.id limit 21`, scope);
      result.reviewLimited ||= reviews.length > 20;
      for (const row of reviews.slice(0, 20)) result.review.push({ key: `automation:${row.id}`, title: row.title, reason: "flow_review", target: { kind: "automation", id: row.id, projectId: row.projectId } });
    }
    if (modules.funnels) {
      const counts = await tx.queryOne<{ funnels: number; activeFunnels: number }>(`select count(*)::integer as funnels,count(*) filter(where status='aktiv' and tracking->'livePublication'->>'tokenHash' is not null)::integer as "activeFunnels" from funnels where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and crm_project_access(workspace_id,project_id,false)`, scope);
      if (counts) Object.assign(result.counts, counts);
    }
    if (modules.properties && installed?.exposes) {
      const count = await tx.queryOne<{ count: number }>(`select count(*)::integer as count from web_expose_versions where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and active`, scope);
      result.counts.publications = count?.count ?? 0;
    }
    result.reviewLimited ||= result.review.length > 20;
    result.review = result.review.slice(0, 20);
    return result;
  }, options);
}
