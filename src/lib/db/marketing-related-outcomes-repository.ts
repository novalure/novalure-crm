import type { AppSession } from "@/lib/auth/session";
import type { TenantTransaction } from "@/lib/crm-command";
import type { MarketingSource } from "@/lib/marketing-domain";

export type MarketingRelatedOutcome = {
  kind: MarketingSource["kind"]; sourceId: string; cohortLeads: number | null;
  confirmedViewings: number | null; bindingReservations: number | null; confirmedSalesAfterEnquiry: number | null;
  datedWonDealsAfterEnquiry: number | null; wonDealsWithoutDate: number | null;
  averageFirstFlowMailMinutes: number | null; flowMailSampleLeads: number | null; leadsWithoutFlowMailEvidence: number | null;
};

/** Related original records, never an advertising-causality or cross-source total. */
export async function readMarketingRelatedOutcomes(tx: TenantTransaction, session: AppSession, sources: MarketingSource[], days: 30 | 90 | 365,
  readable: Set<string>, owner: string | null): Promise<MarketingRelatedOutcome[]> {
  const has = (kind: MarketingSource["kind"]) => sources.some(source => source.kind === kind);
  const available = new Set<MarketingSource["kind"]>();
  const observations: string[] = [];
  for (const [kind, table, sourceColumn, timeColumn] of [
    ["form", "form_submissions", "form_id", "created_at"], ["funnel", "funnel_submissions", "funnel_id", "created_at"],
    ["automation", "crm_automation_enrollments", "automation_id", "enrolled_at"],
  ] as const) {
    if (!has(kind) || !readable.has(table)) continue;
    available.add(kind);
    observations.push(`select '${kind}'::text as kind,s.${sourceColumn} as source_id,l.id as lead_id,l.project_id,s.${timeColumn} as enquiry_at
      from ${table} s join leads l on l.workspace_id=s.workspace_id and l.project_id=s.project_id and l.id=s.lead_id
      where s.workspace_id=$1::uuid and ($2::uuid is null or l.assigned_to_user_id=$2::uuid) ${kind === "automation" ? "" : "and s.mode='live'"}
        and s.${timeColumn}>=clock_timestamp()-make_interval(days=>$3::integer) and s.${timeColumn}<=clock_timestamp() and s.${sourceColumn}=any($4::uuid[])`);
  }
  if (has("expose") && readable.has("web_expose_inquiries")) {
    available.add("expose");
    observations.push(`select 'expose'::text as kind,k.version_id as source_id,l.id as lead_id,l.project_id,s.created_at as enquiry_at
      from web_expose_inquiries s join web_expose_links k on k.workspace_id=s.workspace_id and k.id=s.link_id
      join leads l on l.workspace_id=s.workspace_id and l.id=s.lead_id
      join web_expose_versions v on v.workspace_id=k.workspace_id and v.id=k.version_id and v.project_id=l.project_id
      where s.workspace_id=$1::uuid and ($2::uuid is null or l.assigned_to_user_id=$2::uuid)
        and s.created_at>=clock_timestamp()-make_interval(days=>$3::integer) and s.created_at<=clock_timestamp() and k.version_id=any($4::uuid[])`);
  }
  const none = (): Omit<MarketingRelatedOutcome, "kind" | "sourceId"> => ({ cohortLeads: null, confirmedViewings: null, bindingReservations: null,
    confirmedSalesAfterEnquiry: null, datedWonDealsAfterEnquiry: null, wonDealsWithoutDate: null,
    averageFirstFlowMailMinutes: null, flowMailSampleLeads: null, leadsWithoutFlowMailEvidence: null });
  if (!observations.length) return sources.map(source => ({ kind: source.kind, sourceId: source.id, ...none() }));
  const viewingReady = readable.has("property_viewing_slots"), reservationReady = readable.has("property_reservations"), saleReady = readable.has("property_sales"), dealsReady = readable.has("deals");
  const mailReady = ["crm_automation_mail_deliveries", "crm_automation_drafts", "crm_automation_enrollments"].every(table => readable.has(table));
  const linked = "x.workspace_id=$1::uuid and x.project_id=k.project_id and ";
  const sameGroup = "k.kind=c.kind and k.source_id=c.source_id";
  const count = (ready: boolean, table: string, predicate: string) => ready ? `(select count(distinct x.id)::integer from ${table} x join cohort k on ${linked}${predicate} where ${sameGroup})` : "null::integer";
  const rows = await tx.query<MarketingRelatedOutcome>(`with observed as (${observations.join(" union all ")}),cohort as (
    select kind,source_id,lead_id,project_id,min(enquiry_at) as first_at from observed group by kind,source_id,lead_id,project_id
  ),first_mail as (select c.*,${mailReady ? `(select min(d.accepted_at) from crm_automation_mail_deliveries d
    join crm_automation_drafts a on a.workspace_id=d.workspace_id and a.id=d.draft_id and a.project_id=d.project_id and a.contact_id=d.contact_id
    join crm_automation_enrollments e on e.workspace_id=a.workspace_id and e.id=a.enrollment_id and e.project_id=a.project_id
    where d.workspace_id=$1::uuid and d.project_id=c.project_id and e.lead_id=c.lead_id and d.status='accepted'
      and d.accepted_at>=c.first_at and d.accepted_at<=clock_timestamp() and (c.kind<>'automation' or e.automation_id=c.source_id))` : "null::timestamptz"} as first_mail_at from cohort c)
    select c.kind,c.source_id as "sourceId",count(*)::integer as "cohortLeads",
      ${count(viewingReady,"property_viewing_slots","x.lead_id=k.lead_id and x.status='confirmed'")} as "confirmedViewings",
      ${count(reservationReady,"property_reservations","x.buyer_lead_id=k.lead_id and x.status='reserved' and x.expires_at>clock_timestamp() and jsonb_typeof(x.confirmation)='object' and nullif(trim(x.confirmation->>'sourceReference'),'') is not null and nullif(x.confirmation->>'confirmedAt','') is not null")} as "bindingReservations",
      ${count(saleReady,"property_sales","x.buyer_lead_id=k.lead_id and x.confirmed_at>=k.first_at and x.confirmed_at<=clock_timestamp()")} as "confirmedSalesAfterEnquiry",
      ${count(dealsReady,"deals","x.lead_id=k.lead_id and x.stage in('Gewonnen','Abschluss') and x.closed_at>=k.first_at and x.closed_at<=clock_timestamp()")} as "datedWonDealsAfterEnquiry",
      ${count(dealsReady,"deals","x.lead_id=k.lead_id and x.stage in('Gewonnen','Abschluss') and x.closed_at is null")} as "wonDealsWithoutDate",
      ${mailReady ? "avg(extract(epoch from(c.first_mail_at-c.first_at))/60)::double precision" : "null::double precision"} as "averageFirstFlowMailMinutes",
      ${mailReady ? "count(c.first_mail_at)::integer" : "null::integer"} as "flowMailSampleLeads",
      ${mailReady ? "(count(*)-count(c.first_mail_at))::integer" : "null::integer"} as "leadsWithoutFlowMailEvidence"
    from first_mail c group by c.kind,c.source_id`, [session.workspaceId, owner, days, sources.map(source => source.id)]);
  const empty = (): Omit<MarketingRelatedOutcome, "kind" | "sourceId"> => ({ cohortLeads: 0, confirmedViewings: viewingReady ? 0 : null,
    bindingReservations: reservationReady ? 0 : null, confirmedSalesAfterEnquiry: saleReady ? 0 : null, datedWonDealsAfterEnquiry: dealsReady ? 0 : null,
    wonDealsWithoutDate: dealsReady ? 0 : null, averageFirstFlowMailMinutes: null, flowMailSampleLeads: mailReady ? 0 : null, leadsWithoutFlowMailEvidence: mailReady ? 0 : null });
  return sources.map(source => rows.find(row => row.kind === source.kind && row.sourceId === source.id) ?? ({ kind: source.kind, sourceId: source.id, ...(available.has(source.kind) ? empty() : none()) }));
}
