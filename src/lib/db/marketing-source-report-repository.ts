import type { AppSession } from "@/lib/auth/session";
import type { TenantTransaction } from "@/lib/crm-command";
import type { MarketingSource } from "@/lib/marketing-domain";

export type MarketingAttribution = {
  kind: MarketingSource["kind"]; sourceId: string; source: string; medium: string; campaign: string;
  submissions: number; firstRecorded: number; subsequent: number;
};

/** Source observations only. No ad-cost assumptions or cross-source conversion sums. */
export async function readMarketingSourceDetails(
  tx: TenantTransaction, session: AppSession, sources: MarketingSource[], days: 30 | 90 | 365,
  installed: Set<string>, owner: string | null,
): Promise<MarketingAttribution[]> {
  const ids = (kind: MarketingSource["kind"]) => sources.filter(source => source.kind === kind).map(source => source.id);
  if (installed.has("crm_provider_delivery_events")) {
    const rows = await tx.query<{ id: string; event: string; count: number }>(`select d.campaign_id as id,e.event_type as event,count(distinct d.id)::integer as count
      from crm_provider_delivery_events e join crm_newsletter_deliveries d on d.workspace_id=e.workspace_id and d.id=e.delivery_id
      join contacts c on c.workspace_id=d.workspace_id and c.id=d.contact_id
      where e.workspace_id=$1::uuid and e.delivery_kind='newsletter' and d.campaign_id=any($2::uuid[]) and ($3::uuid is null or c.owner_user_id=$3::uuid)
        and e.received_at>=clock_timestamp()-make_interval(days=>$4::integer) group by d.campaign_id,e.event_type`, [session.workspaceId, ids("newsletter"), owner, days]);
    for (const row of rows) {
      const source = sources.find(source => source.kind === "newsletter" && source.id === row.id);
      if (source) source.results[`provider:${row.event}`] = row.count;
    }
  }
  if (installed.has("web_expose_events") && installed.has("web_expose_sessions")) {
    const rows = await tx.query<{ id: string; visits: number; activeMs: number; actions: number }>(`select l.version_id as id,
      count(distinct s.id) filter(where e.event_type='open')::integer as visits,coalesce(sum(e.active_ms),0)::double precision as "activeMs",
      count(*) filter(where e.event_type not in('open','section','heartbeat'))::integer as actions
      from web_expose_events e join web_expose_sessions s on s.workspace_id=e.workspace_id and s.id=e.session_id
      join web_expose_links l on l.workspace_id=s.workspace_id and l.id=s.link_id
      where e.workspace_id=$1::uuid and l.version_id=any($2::uuid[]) and s.withdrawn_at is null
        and e.received_at>=clock_timestamp()-make_interval(days=>$3::integer) group by l.version_id`, [session.workspaceId, ids("expose"), days]);
    for (const row of rows) {
      const source = sources.find(source => source.kind === "expose" && source.id === row.id);
      if (source) Object.assign(source.results, { measuredVisits: row.visits, activeMs: row.activeMs, actions: row.actions });
    }
  }
  if (installed.has("crm_automation_enrollments")) {
    const rows = await tx.query<{ id: string; status: string; count: number }>(`select e.automation_id as id,e.status,count(*)::integer as count
      from crm_automation_enrollments e join leads l on l.workspace_id=e.workspace_id and l.id=e.lead_id
      where e.workspace_id=$1::uuid and e.automation_id=any($2::uuid[]) and ($3::uuid is null or l.assigned_to_user_id=$3::uuid)
        and e.enrolled_at>=clock_timestamp()-make_interval(days=>$4::integer) group by e.automation_id,e.status`, [session.workspaceId, ids("automation"), owner, days]);
    for (const row of rows) {
      const source = sources.find(source => source.kind === "automation" && source.id === row.id);
      if (source) source.results[`run:${row.status}`] = row.count;
    }
  }
  // Rank before filtering the report period/source, so a repeat is not made new by a date filter.
  // The definition is deliberately the first recorded public submission of a visible CRM lead.
  const observations: string[] = [];
  const utm = (field: string) => `coalesce(nullif(left(s.tracking->'utm'->>'${field}',160),''),nullif(left(s.tracking->>'${field}',160),''),'')`;
  for (const [kind, table, column] of [["form", "form_submissions", "form_id"], ["funnel", "funnel_submissions", "funnel_id"]] as const) {
    if (!installed.has(table) || !ids(kind).length) continue;
    observations.push(`select '${kind}'::text as kind,s.${column} as source_id,s.id,s.lead_id,s.created_at,${utm("utm_source")} as source,${utm("utm_medium")} as medium,${utm("utm_campaign")} as campaign
      from ${table} s join leads l on l.workspace_id=s.workspace_id and l.id=s.lead_id where s.workspace_id=$1::uuid and s.mode='live' and ($2::uuid is null or l.assigned_to_user_id=$2::uuid)`);
  }
  if (installed.has("web_expose_inquiries") && ids("expose").length) observations.push(`select 'expose'::text as kind,k.version_id as source_id,s.id,s.lead_id,s.created_at,
    k.label as source,'Exposé-Link'::text as medium,''::text as campaign from web_expose_inquiries s join web_expose_links k on k.workspace_id=s.workspace_id and k.id=s.link_id
    join leads l on l.workspace_id=s.workspace_id and l.id=s.lead_id where s.workspace_id=$1::uuid and ($2::uuid is null or l.assigned_to_user_id=$2::uuid)`);
  if (!observations.length) return [];
  return tx.query<MarketingAttribution>(`with observed as (${observations.join(" union all ")}),ranked as (
    select *,row_number() over(partition by lead_id order by created_at,id,kind) as sequence from observed)
    select kind,source_id as "sourceId",coalesce(nullif(source,''),'Nicht erfasst') as source,coalesce(nullif(medium,''),'Nicht erfasst') as medium,
      coalesce(nullif(campaign,''),'Nicht erfasst') as campaign,count(*)::integer as submissions,
      count(*) filter(where sequence=1)::integer as "firstRecorded",count(*) filter(where sequence>1)::integer as subsequent
    from ranked where created_at>=clock_timestamp()-make_interval(days=>$3::integer) and source_id=any($4::uuid[])
    group by kind,source_id,source,medium,campaign order by count(*) desc,kind,source_id,source limit 201`, [session.workspaceId, owner, days, sources.map(source => source.id)]);
}
