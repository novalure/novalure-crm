import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import { isProjectReportMonth, parseProjectReportSettings, type ProjectSalesReportData } from "@/lib/project-sales-report";

async function projectScope(tx: TenantTransaction, session: AppSession, projectId: string, write = false) {
  assertCrmUuid(projectId); await assertProjectGrant(tx, session, projectId, write);
  const project = await tx.queryOne<{ id: string; name: string }>(`select id,name from projects where id=$1::uuid and workspace_id=$2::uuid${write ? " for update" : ""}`, [projectId, session.workspaceId]);
  if (!project) throw new CrmCommandError("NOT_FOUND", "Projekt nicht verfügbar", 404);
  return project;
}
export async function saveProjectReportSettings(tx: TenantTransaction, session: AppSession, projectId: string, value: unknown, expectedRevision: number) {
  await projectScope(tx, session, projectId, true);
  let settings: ReturnType<typeof parseProjectReportSettings>;
  try { settings = parseProjectReportSettings(value); } catch { throw new CrmCommandError("INVALID_REPORT_SETTINGS", "Monat, Zeitzone und Ziele prüfen"); }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CrmCommandError("INVALID_REVISION", "Zielversion fehlt");
  const manager = await tx.queryOne<{ allowed: boolean }>(`select crm_workspace_manager($1::uuid) as allowed`, [session.workspaceId]);
  if (!manager?.allowed || !session.permissions.includes("crm:write")) throw new CrmCommandError("FORBIDDEN", "Ziele dürfen nur Verantwortliche mit Verwaltungsrechten ändern", 403);
  const current = await tx.queryOne<{ revision: number }>(`select revision from project_sales_report_settings where workspace_id=$1::uuid and project_id=$2::uuid and month=$3 for update`, [session.workspaceId, projectId, settings.month]);
  if ((current?.revision ?? 0) !== expectedRevision) throw new CrmCommandError("TARGET_CONFLICT", "Monatsziele wurden geändert. Bitte neu laden.", 409);
  const row = await tx.queryOne<{ revision: number }>(`insert into project_sales_report_settings(workspace_id,project_id,month,time_zone,unit_sales_target,won_deal_value_target_cents,updated_by) values($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7::uuid) on conflict(workspace_id,project_id,month) do update set time_zone=excluded.time_zone,unit_sales_target=excluded.unit_sales_target,won_deal_value_target_cents=excluded.won_deal_value_target_cents,revision=project_sales_report_settings.revision+1,updated_by=excluded.updated_by,updated_at=now() returning revision`, [session.workspaceId, projectId, settings.month, settings.timeZone, settings.unitSalesTarget, settings.wonDealValueTargetCents, session.userId]);
  if (!row) throw new CrmCommandError("SAVE_UNCONFIRMED", "Monatsziele nicht bestätigt", 503);
  return { ...settings, revision: row.revision };
}
/** One aggregate statement gives every count the same database snapshot without multiplying joins. */
export async function loadProjectSalesReport(tx: TenantTransaction, session: AppSession, projectId: string, month: string): Promise<ProjectSalesReportData> {
  const project = await projectScope(tx, session, projectId);
  if (!isProjectReportMonth(month)) throw new CrmCommandError("INVALID_MONTH", "Berichtsmonat im Format YYYY-MM angeben");
  const asOf = new Date().toISOString();
  const row = await tx.queryOne<{ data: Omit<ProjectSalesReportData, "project" | "month" | "asOf" | "definitions" | "unavailable"> }>(`
    with settings as (
      select revision,time_zone,unit_sales_target,won_deal_value_target_cents from project_sales_report_settings where workspace_id=$1::uuid and project_id=$2::uuid and month=$3
      union all select 0,'UTC',null::integer,null::bigint where not exists(select 1 from project_sales_report_settings where workspace_id=$1::uuid and project_id=$2::uuid and month=$3)
    ), bounds as (
      select settings.*, (($3||'-01')::date::timestamp at time zone time_zone) as start_at,
        ((($3||'-01')::date+interval '1 month')::timestamp at time zone time_zone) as end_at from settings
    ), units as (
      select u.id,u.status,u.price_cents,
        exists(select 1 from property_reservations r where r.workspace_id=$1::uuid and r.project_id=$2::uuid and r.unit_id=u.id and r.status='hold' and r.expires_at>$4::timestamptz) as held,
        exists(select 1 from property_reservations r where r.workspace_id=$1::uuid and r.project_id=$2::uuid and r.unit_id=u.id and r.status='reserved' and r.expires_at>$4::timestamptz) as reserved
      from property_units u where u.workspace_id=$1::uuid and u.project_id=$2::uuid and coalesce(u.metadata->>'defaultUnit','false')<>'true'
    ), classified as (
      select id,price_cents,case when status='sold' then 'sold' when status='blocked' then 'blocked' when status='reserved' or reserved then 'reserved' when held then 'hold' else 'available' end as report_status from units
    ), status_rows as (
      select state.status,count(c.id)::int as count,coalesce(sum(c.price_cents),0)::text as value from (values('available',1),('hold',2),('reserved',3),('sold',4),('blocked',5)) as state(status,ord)
        left join classified c on c.report_status=state.status group by state.status,state.ord order by state.ord
    ), won as (
      select d.* from deals d where d.workspace_id=$1::uuid and d.project_id=$2::uuid and d.stage in ('Gewonnen','Abschluss') and (d.metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true'
    ), confirmed as (
      select ps.* from property_sales ps join units u on u.id=ps.unit_id where ps.workspace_id=$1::uuid and ps.project_id=$2::uuid
        and exists(select 1 from leads l where l.id=ps.buyer_lead_id and l.workspace_id=$1::uuid and (l.metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true')
    ) select jsonb_build_object(
      'timeZone',b.time_zone,'settings',jsonb_build_object('revision',b.revision,'month',$3,'timeZone',b.time_zone,'unitSalesTarget',b.unit_sales_target,'wonDealValueTargetCents',b.won_deal_value_target_cents::text),
      'canConfigure',crm_workspace_manager($1::uuid) and crm_project_access($1::uuid,$2::uuid,true),
      'inventory',jsonb_build_object('total',(select count(*)::int from units),'states',(select jsonb_agg(jsonb_build_object('status',status,'count',count,'askingValueCents',value)) from status_rows),
        'listings',(select count(*)::int from seller_listings where workspace_id=$1::uuid and project_id=$2::uuid),
        'excludedDefaultUnits',(select count(*)::int from property_units where workspace_id=$1::uuid and project_id=$2::uuid and metadata->>'defaultUnit'='true'),
        'expiredOpenReservations',(select count(*)::int from property_reservations where workspace_id=$1::uuid and project_id=$2::uuid and status in ('requested','hold','reserved') and expires_at<=$4::timestamptz),
        'pendingRequests',(select count(*)::int from property_reservations where workspace_id=$1::uuid and project_id=$2::uuid and status='requested' and expires_at>$4::timestamptz)),
      'sales',jsonb_build_object('confirmedThisMonth',(select count(*)::int from confirmed where confirmed_at>=b.start_at and confirmed_at<b.end_at),'confirmedAllTime',(select count(*)::int from confirmed),
        'soldWithoutConfirmation',(select count(*)::int from units u where u.status='sold' and not exists(select 1 from property_sales ps where ps.workspace_id=$1::uuid and ps.project_id=$2::uuid and ps.unit_id=u.id))),
      'deals',jsonb_build_object('wonThisMonth',(select count(*)::int from won where closed_at>=b.start_at and closed_at<b.end_at),
        'wonValueThisMonthCents',(select coalesce(sum(value_cents),0)::text from won where closed_at>=b.start_at and closed_at<b.end_at),'wonWithoutClosingDate',(select count(*)::int from won where closed_at is null)),
      'offers',coalesce((select jsonb_agg(jsonb_build_object('status',status,'count',n)) from(select status,count(*)::int n from crm_offers where workspace_id=$1::uuid and project_id=$2::uuid group by status order by status) offers),'[]'::jsonb),
      'leadSources',coalesce((select jsonb_agg(jsonb_build_object('source',source,'count',n)) from(select coalesce(nullif(l.source,''),'Unbekannt') as source,count(*)::int n from leads l where l.workspace_id=$1::uuid and l.project_id=$2::uuid and l.received_at>=b.start_at and l.received_at<b.end_at and (l.metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true' group by coalesce(nullif(l.source,''),'Unbekannt') order by n desc,source) sources),'[]'::jsonb)
    ) as data from bounds b`, [session.workspaceId, projectId, month, asOf]);
  if (!row) throw new CrmCommandError("REPORT_UNAVAILABLE", "Projektbericht nicht verfügbar", 503);
  return { project, month, asOf, ...row.data, definitions: [
    { id: "inventory", text: "Einheitenstatus zum Datenstand: verkauft/gesperrt/reserviert haben Vorrang. Ein verfügbarer Bestand mit nicht abgelaufener Vormerkung erscheint als vorgemerkt. Reservierungsanfragen sind keine Bestätigung. Jede physische Einheit wird genau einmal gezählt; automatische Hilfseinheiten und Objektdatensätze werden getrennt geführt." },
    { id: "value", text: "Bestandswerte sind aktuelle gespeicherte Einheiten-Angebotspreise in EUR. Sie sind weder beurkundete Kaufpreise noch Zahlungseingang, Umsatz oder Provision. Objektpreise werden nicht zusätzlich zu Einheitenpreisen summiert." },
    { id: "sales", text: "Bestätigte Monatsverkäufe stammen aus property_sales.confirmed_at innerhalb des ausgewählten Monats und der Berichtszeitzone. Ein als verkauft markierter Altbestand ohne Bestätigung wird keinem erfundenen Verkaufsmonat zugeteilt." },
    { id: "deals", text: "Gewonnener Dealwert zählt Gewonnen/Abschluss mit gespeichertem closed_at innerhalb des Monats. Erwartete Abschlussdaten und Änderungsdaten ersetzen keinen fehlenden Abschlusszeitpunkt. Ein angenommenes Angebot ist kein bestätigter Einheitenverkauf." },
    { id: "sources", text: "Leadquellen zählen neu eingegangene Leads im Monat nach received_at; Angebote zeigen den aktuellen Status zum Datenstand. Explizit markierte synthetische Website-Vertriebstests werden aus den Lead-/Deal-/Verkaufskennzahlen ausgeschlossen." },
    { id: "targets", text: "Monatsziele sind manuell gespeicherte Projektziele. Leere Ziele bleiben unbekannt; ohne gespeicherte Konfiguration gilt die ausdrücklich angezeigte Berichtszeitzone UTC. Es wird kein pauschaler Provisionssatz angenommen." },
  ], unavailable: ["Zahlungseingänge, fakturierter Umsatz und tatsächlich verdiente Provision sind aus diesen Quellen nicht belegt und werden nicht berechnet.", ...(row.data.sales.soldWithoutConfirmation ? [`${row.data.sales.soldWithoutConfirmation} verkaufte Bestandseinheiten ohne bestätigten Verkaufsvorgang.`] : []), ...(row.data.deals.wonWithoutClosingDate ? [`${row.data.deals.wonWithoutClosingDate} gewonnene Deals ohne belegtes Abschlussdatum; ohne Monatszuordnung.`] : [])] };
}
