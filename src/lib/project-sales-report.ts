import { buildCrmCsv } from "./crm-transfer";

export type ProjectReportSettings = { revision: number; month: string; timeZone: string; unitSalesTarget: number | null; wonDealValueTargetCents: string | null };
export type ProjectSalesReportData = {
  project: { id: string; name: string }; month: string; timeZone: string; asOf: string; settings: ProjectReportSettings; canConfigure: boolean;
  inventory: { total: number; states: { status: "available" | "hold" | "reserved" | "sold" | "blocked"; count: number; askingValueCents: string }[]; listings: number; excludedDefaultUnits: number; expiredOpenReservations: number; pendingRequests: number };
  sales: { confirmedThisMonth: number; confirmedAllTime: number; soldWithoutConfirmation: number };
  deals: { wonThisMonth: number; wonValueThisMonthCents: string; wonWithoutClosingDate: number };
  offers: { status: string; count: number }[]; leadSources: { source: string; count: number }[]; definitions: { id: string; text: string }[]; unavailable: string[];
};
const englishDefinitions: Record<string, string> = {
  inventory: "Inventory is the current state: sold/blocked/reserved take precedence. An otherwise available unit with an unexpired hold is shown as on hold. A reservation request is not a confirmation. Each physical unit is counted once; automatic helper units and property records are reported separately.",
  value: "Inventory values are current recorded unit asking prices in EUR. They are not notarised prices, received payments, revenue or commission. Property asking prices are not added to unit values.",
  sales: "Confirmed monthly unit sales use property_sales.confirmed_at within the selected calendar month and report timezone. Legacy units marked sold without a confirmation are not assigned to an invented sale month.",
  deals: "Won deal value counts Gewonnen/Abschluss records with closed_at within the month. Expected closing dates and modification dates never replace a missing actual closing timestamp. An accepted offer is separate from a confirmed unit sale.",
  sources: "Lead sources count incoming leads by received_at in the month. Offers show their current status. Explicitly flagged synthetic website sales tests are excluded from lead, deal and confirmed-sale metrics.",
  targets: "Monthly targets are explicitly saved project settings. Blank targets remain unset. Without saved settings, the displayed report timezone is UTC. No commission rate is assumed.",
};
export function localizeProjectSalesReport(report: ProjectSalesReportData, language: string): ProjectSalesReportData {
  if (language !== "en") return report;
  return { ...report, definitions: report.definitions.map((definition) => ({ ...definition, text: englishDefinitions[definition.id] ?? definition.text })), unavailable: ["Payments, invoiced revenue and earned commission are not established by these sources and are not calculated.", ...(report.sales.soldWithoutConfirmation ? [`${report.sales.soldWithoutConfirmation} sold inventory units have no confirmed sale record.`] : []), ...(report.deals.wonWithoutClosingDate ? [`${report.deals.wonWithoutClosingDate} won deals have no recorded closing date and cannot be assigned to a month.`] : [])] };
}
export const projectReportStateLabels = {
  de: { available: "Verfügbar", hold: "Vorgemerkt", reserved: "Reserviert", sold: "Verkauft", blocked: "Gesperrt" },
  en: { available: "Available", hold: "On hold", reserved: "Reserved", sold: "Sold", blocked: "Blocked" },
} as const;
export function isProjectReportMonth(value: unknown): value is string { return typeof value === "string" && /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(value); }
export function parseProjectReportSettings(value: unknown): Omit<ProjectReportSettings, "revision"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REPORT_SETTINGS");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["month", "timeZone", "unitSalesTarget", "wonDealValueTargetCents"].includes(key)) || !isProjectReportMonth(input.month) || typeof input.timeZone !== "string" || input.timeZone.length > 80 ||
      (input.unitSalesTarget !== null && (!Number.isSafeInteger(input.unitSalesTarget) || Number(input.unitSalesTarget) < 0 || Number(input.unitSalesTarget) > 1000000)) ||
      (input.wonDealValueTargetCents !== null && (typeof input.wonDealValueTargetCents !== "string" || !/^\d{1,16}$/.test(input.wonDealValueTargetCents) || BigInt(input.wonDealValueTargetCents) > BigInt(Number.MAX_SAFE_INTEGER)))) throw new Error("INVALID_REPORT_SETTINGS");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(); } catch { throw new Error("INVALID_REPORT_TIMEZONE"); }
  return { month: input.month, timeZone: input.timeZone, unitSalesTarget: input.unitSalesTarget as number | null, wonDealValueTargetCents: input.wonDealValueTargetCents as string | null };
}
export function projectReportMoney(cents: string | null, locale = "de-AT") {
  if (cents === null || !/^\d+$/.test(cents)) return "—";
  const value = BigInt(cents), whole = value / BigInt(100), fraction = String(value % BigInt(100)).padStart(2, "0");
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).formatToParts(whole).map((part) => part.type === "fraction" ? fraction : part.value).join("");
}
export function buildProjectSalesReportCsv(report: ProjectSalesReportData) {
  const rows: unknown[][] = [["project", report.project.name, "", "", ""], ["month", report.month, "", "", ""], ["timezone", report.timeZone, "", "", ""], ["as_of", report.asOf, "", "", ""]];
  for (const state of report.inventory.states) rows.push(["inventory_snapshot", state.status, state.count, state.askingValueCents, "EUR cents; current asking value, not revenue"]);
  rows.push(["confirmed_sales_in_month", "", report.sales.confirmedThisMonth, "", "property_sales.confirmed_at"], ["won_deals_in_month", "", report.deals.wonThisMonth, report.deals.wonValueThisMonthCents, "EUR cents; won deal value, not payment/commission"], ["sold_without_confirmation", "", report.sales.soldWithoutConfirmation, "", "Not allocated to a sales month"], ["unit_sales_target", "", report.settings.unitSalesTarget, "", "No default target"], ["won_deal_value_target", "", "", report.settings.wonDealValueTargetCents, "EUR cents; no default target"]);
  for (const source of report.leadSources) rows.push(["lead_source_in_month", source.source, source.count, "", "received_at; synthetic website tests excluded"]);
  for (const offer of report.offers) rows.push(["offer_status_snapshot", offer.status, offer.count, "", "Offer acceptance is separate from unit sale"]);
  for (const definition of report.definitions) rows.push(["definition", definition.id, "", "", definition.text]);
  for (const missing of report.unavailable) rows.push(["unavailable", missing, "", "", ""]);
  return buildCrmCsv(["metric", "group", "count_or_target", "amount_cents", "definition"], rows);
}
const escapeHtml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function buildProjectSalesReportPrintHtml(report: ProjectSalesReportData, language: string) {
  report = localizeProjectSalesReport(report, language);
  const de = language === "de", labels = projectReportStateLabels[de ? "de" : "en"], locale = de ? "de-AT" : "en-IE";
  const table = (heads: string[], rows: string[][]) => `<table><thead><tr>${heads.map((head) => `<th>${escapeHtml(head)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="${de ? "de" : "en"}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(report.project.name)} · ${escapeHtml(report.month)}</title><style>@page{size:A4;margin:16mm}body{font-family:Arial,sans-serif;color:#14223b;font-size:11pt;line-height:1.45}h1{font-size:24pt}h2{font-size:15pt;margin-top:24px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;border-bottom:1px solid #d7dee8;padding:8px}th{background:#f0f4f8}p,li{overflow-wrap:anywhere}tr{break-inside:avoid}.muted{color:#536173}</style></head><body><h1>${de ? "Projektvertriebsbericht" : "Project sales report"}</h1><h2>${escapeHtml(report.project.name)}</h2><p>${escapeHtml(report.month)} · ${escapeHtml(report.timeZone)} · ${de ? "Datenstand" : "As of"}: ${escapeHtml(report.asOf)}</p><h2>${de ? "Einheiten zum Datenstand" : "Unit inventory at report time"}</h2>${table([de ? "Status" : "Status", de ? "Anzahl" : "Count", de ? "Aktueller Angebotspreis" : "Current asking value"], report.inventory.states.map((state) => [labels[state.status], String(state.count), projectReportMoney(state.askingValueCents, locale)]))}<p>${de ? "Objektdatensätze" : "Property records"}: ${report.inventory.listings} · ${de ? "Ausgeschlossene automatische Hilfseinheiten" : "Excluded automatic helper units"}: ${report.inventory.excludedDefaultUnits}</p><h2>${de ? "Monatsvorgänge und Ziele" : "Monthly activity and targets"}</h2>${table([de ? "Kennzahl" : "Metric", de ? "Ist" : "Actual", de ? "Ziel" : "Target"], [[de ? "Bestätigte Einheitenverkäufe" : "Confirmed unit sales", String(report.sales.confirmedThisMonth), report.settings.unitSalesTarget === null ? "—" : String(report.settings.unitSalesTarget)], [de ? "Gewonnener Dealwert" : "Won deal value", projectReportMoney(report.deals.wonValueThisMonthCents, locale), projectReportMoney(report.settings.wonDealValueTargetCents, locale)]])}<h2>${de ? "Leadquellen im Monat" : "Monthly lead sources"}</h2>${table([de ? "Quelle" : "Source", de ? "Anzahl" : "Count"], report.leadSources.map((source) => [source.source, String(source.count)]))}<h2>${de ? "Angebotsstatus zum Datenstand" : "Offer status at report time"}</h2>${table(["Status", de ? "Anzahl" : "Count"], report.offers.map((offer) => [offer.status, String(offer.count)]))}<h2>${de ? "Definitionen und offene Daten" : "Definitions and unavailable data"}</h2><ul>${report.definitions.map((definition) => `<li>${escapeHtml(definition.text)}</li>`).join("")}${report.unavailable.map((missing) => `<li>${escapeHtml(missing)}</li>`).join("")}</ul></body></html>`;
}
