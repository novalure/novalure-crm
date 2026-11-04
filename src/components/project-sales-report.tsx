"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import { parsePropertyEuroCents } from "@/lib/property-money";
import { buildProjectSalesReportPrintHtml, projectReportMoney, projectReportStateLabels, type ProjectSalesReportData } from "@/lib/project-sales-report";

type Props = { workspaceId: string; projectId: string; language: string };
const inputClass = "mt-1 min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm";
const button = "min-h-11 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50";
const euros = (cents: string | null) => cents === null ? "" : `${BigInt(cents) / BigInt(100)}.${String(BigInt(cents) % BigInt(100)).padStart(2, "0")}`;
export function ProjectSalesReport(props: Props) { return <ProjectReport key={`${props.workspaceId}:${props.projectId}`} {...props} />; }
function ProjectReport({ workspaceId, projectId, language }: Props) {
  const de = language === "de", locale = de ? "de-AT" : "en-IE", labels = projectReportStateLabels[de ? "de" : "en"];
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7)), [report, setReport] = useState<ProjectSalesReportData | null>(null);
  const [timeZone, setTimeZone] = useState("UTC"), [unitTarget, setUnitTarget] = useState(""), [valueTarget, setValueTarget] = useState("");
  const [revisionTick, setRevisionTick] = useState(0), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ key: string; correlation: string; body: string } | null>(null), busyRef = useRef(false);
  const endpoint = `/api/crm/project-sales-report?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}&month=${encodeURIComponent(month)}&lang=${de ? "de" : "en"}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const result = await response.json() as { data?: ProjectSalesReportData; error?: string };
      if (!response.ok || !result.data) throw new Error(result.error || (de ? "Projektbericht nicht verfügbar" : "Project report unavailable"));
      if (!controller.signal.aborted) { setReport(result.data); setTimeZone(result.data.settings.timeZone); setUnitTarget(result.data.settings.unitSalesTarget === null ? "" : String(result.data.settings.unitSalesTarget)); setValueTarget(euros(result.data.settings.wonDealValueTargetCents)); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Bericht nicht verfügbar"); });
    return () => controller.abort();
  }, [endpoint, revisionTick, de]);
  async function save(event?: FormEvent) {
    event?.preventDefault(); if (busyRef.current || !report || report.month !== month) return;
    const cents = valueTarget.trim() ? parsePropertyEuroCents(valueTarget) : null;
    const count = unitTarget.trim() ? Number(unitTarget) : null;
    if ((valueTarget.trim() && cents === null) || (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 1000000))) { setNotice(de ? "Gültige Monatsziele eingeben oder Felder leer lassen." : "Enter valid monthly targets or leave the fields blank."); return; }
    busyRef.current = true; setBusy(true); setNotice("");
    const attempt = pending.current ?? { key: crypto.randomUUID(), correlation: crypto.randomUUID(), body: JSON.stringify({ projectId, expectedRevision: report.settings.revision, settings: { month, timeZone, unitSalesTarget: count, wonDealValueTargetCents: cents === null ? null : String(cents) } }) };
    pending.current = attempt;
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.key, "x-correlation-id": attempt.correlation }, body: attempt.body });
      const result = await response.json() as { persisted?: boolean; error?: string };
      if (!response.ok) { if (response.status < 500) { pending.current = null; setUncertain(false); } throw new Error(result.error || (de ? "Speicherung nicht bestätigt" : "Save not confirmed")); }
      if (!result.persisted) throw new Error(de ? "Speicherung nicht bestätigt" : "Save not confirmed");
      pending.current = null; setUncertain(false); setNotice(de ? "Monatsziele gespeichert." : "Monthly targets saved."); setRevisionTick((current) => current + 1);
    } catch (error) { if (pending.current) setUncertain(true); setNotice(error instanceof Error ? error.message : (de ? "Verbindung unterbrochen" : "Connection interrupted")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function print() {
    if (!report || report.month !== month) return;
    const popup = window.open("", "_blank", "width=1000,height=850");
    if (!popup) { setNotice(de ? "Druckansicht konnte nicht geöffnet werden. Bitte Pop-ups für diese Anwendung erlauben." : "Print view could not open. Allow pop-ups for this application."); return; }
    popup.opener = null; popup.document.write(buildProjectSalesReportPrintHtml(report, language)); popup.document.close(); popup.focus(); popup.print();
  }
  async function downloadCsv() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      const response = await fetch(`${endpoint}&format=csv`, { cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/csv")) throw new Error(de ? "CSV nicht verfügbar" : "CSV unavailable");
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = `novalure-project-${projectId}-${month}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Download nicht bestätigt"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const current = report?.month === month ? report : null;
  return <section className="mt-5 min-w-0 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5" aria-labelledby={`project-report-${projectId}`}>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id={`project-report-${projectId}`} className="text-xl font-semibold">{de ? "Projektvertriebsbericht" : "Project sales report"}</h3><p className="mt-1 text-sm text-stone-600">{current?.project.name ?? ""}</p></div><label className="text-sm font-medium">{de ? "Berichtsmonat" : "Report month"}<input className={inputClass} type="month" required value={month} disabled={busy || uncertain} onChange={(event) => { if (event.target.value) { setMonth(event.target.value); setNotice(""); } }} /></label><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!current || busy} onClick={() => void downloadCsv()}>CSV</button><button type="button" className={button} disabled={!current || busy} onClick={print}>{de ? "Drucken / als PDF speichern" : "Print / save as PDF"}</button></div></div>
    {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
    {uncertain ? <button type="button" disabled={busy} className={`${button} mt-3`} onClick={() => void save()}>{de ? "Unbestätigte Speicherung erneut prüfen" : "Recheck unconfirmed save"}</button> : null}
    {!current ? <p className="mt-4 text-sm">{de ? "Bericht wird geladen …" : "Loading report …"}</p> : <>
      <p className="mt-3 text-sm text-stone-600">{de ? "Bestand zum Datenstand" : "Inventory as of"}: {new Date(current.asOf).toLocaleString(locale, { timeZone: current.timeZone })} · {current.timeZone}. {de ? "Monatsvorgänge werden getrennt vom aktuellen Bestand gezählt." : "Monthly activity is counted separately from current inventory."}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{current.inventory.states.map((state) => <article key={state.status} className="rounded-xl border border-stone-200 bg-stone-50 p-4"><h4 className="text-sm font-medium">{labels[state.status]}</h4><p className="mt-2 text-3xl font-semibold">{state.count}</p><p className="mt-2 text-sm">{projectReportMoney(state.askingValueCents, locale)}</p><p className="mt-1 text-xs text-stone-600">{de ? "Aktueller Einheiten-Angebotswert" : "Current unit asking value"}</p></article>)}</div>
      <p className="mt-3 text-sm text-stone-600">{current.inventory.total} {de ? "physische Einheiten" : "physical units"} · {current.inventory.listings} {de ? "Objektdatensätze" : "property records"} · {current.inventory.excludedDefaultUnits} {de ? "automatische Hilfseinheiten ausgeschlossen" : "automatic helper units excluded"} · {current.inventory.pendingRequests} {de ? "unbestätigte Reservierungsanfragen" : "unconfirmed reservation requests"}.</p>
      {current.inventory.expiredOpenReservations ? <p className="mt-2 text-sm text-amber-900">{current.inventory.expiredOpenReservations} {de ? "Vormerkungen/Reservierungen mit abgelaufener Frist prüfen. Der Bericht hebt keine Reservierung auf." : "holds/reservations with an expired deadline need review. The report does not release reservations."}</p> : null}
      <div className="mt-5 grid gap-4 sm:grid-cols-2"><article className="rounded-xl border border-stone-200 p-4"><h4 className="font-semibold">{de ? "Bestätigte Einheitenverkäufe im Monat" : "Confirmed unit sales this month"}</h4><p className="mt-2 text-3xl font-semibold">{current.sales.confirmedThisMonth}</p><p className="mt-2 text-sm">{de ? "Monatsziel" : "Monthly target"}: {current.settings.unitSalesTarget === null ? (de ? "nicht gesetzt" : "not set") : current.settings.unitSalesTarget}</p></article><article className="rounded-xl border border-stone-200 p-4"><h4 className="font-semibold">{de ? "Gewonnener Dealwert im Monat" : "Won deal value this month"}</h4><p className="mt-2 text-2xl font-semibold">{projectReportMoney(current.deals.wonValueThisMonthCents, locale)}</p><p className="mt-2 text-sm">{current.deals.wonThisMonth} Deals · {de ? "Ziel" : "Target"}: {current.settings.wonDealValueTargetCents === null ? (de ? "nicht gesetzt" : "not set") : projectReportMoney(current.settings.wonDealValueTargetCents, locale)}</p></article></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2"><article><h4 className="font-semibold">{de ? "Leadquellen im Monat" : "Monthly lead sources"}</h4>{current.leadSources.length ? <ul className="mt-2 space-y-2">{current.leadSources.map((source) => <li className="flex justify-between gap-3 rounded-xl bg-stone-50 p-3 text-sm" key={source.source}><span className="break-words">{source.source}</span><strong>{source.count}</strong></li>)}</ul> : <p className="mt-2 text-sm text-stone-600">{de ? "Keine neuen Leads in diesem Monat." : "No new leads this month."}</p>}</article><article><h4 className="font-semibold">{de ? "Aktuelle Angebotsstände" : "Current offer status"}</h4>{current.offers.length ? <ul className="mt-2 space-y-2">{current.offers.map((offer) => <li className="flex justify-between gap-3 rounded-xl bg-stone-50 p-3 text-sm" key={offer.status}><span>{offer.status}</span><strong>{offer.count}</strong></li>)}</ul> : <p className="mt-2 text-sm text-stone-600">{de ? "Keine gespeicherten Angebote." : "No saved offers."}</p>}</article></div>
      {current.canConfigure ? <details className="mt-5 rounded-xl border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-semibold">{de ? "Monatsziele und Berichtszeitzone" : "Monthly targets and report timezone"}</summary><form onSubmit={(event) => void save(event)}><fieldset disabled={busy || uncertain} className="mt-3 grid gap-4 sm:grid-cols-3"><label className="text-sm font-medium">{de ? "Einheitenverkäufe (Ziel)" : "Unit sales target"}<input className={inputClass} type="number" min="0" max="1000000" step="1" value={unitTarget} onChange={(event) => setUnitTarget(event.target.value)} /></label><label className="text-sm font-medium">{de ? "Gewonnener Dealwert (Ziel, EUR)" : "Won deal value target (EUR)"}<input className={inputClass} type="number" min="0" step="0.01" value={valueTarget} onChange={(event) => setValueTarget(event.target.value)} /></label><label className="text-sm font-medium">{de ? "Berichtszeitzone" : "Report timezone"}<input className={inputClass} required maxLength={80} value={timeZone} onChange={(event) => setTimeZone(event.target.value)} list={`report-timezones-${projectId}`} /><datalist id={`report-timezones-${projectId}`}>{["UTC", "Europe/Vienna", "Europe/Berlin", "Europe/Madrid", "Atlantic/Canary", "Europe/Dublin"].map((zone) => <option key={zone} value={zone} />)}</datalist></label></fieldset><p className="mt-3 text-sm text-stone-600">{de ? "Leere Zielfelder bedeuten: kein Ziel gesetzt. Ziele gelten für den gewählten Monat. Es werden keine Provisionssätze oder Zahlungseingänge angenommen." : "Blank targets mean no target has been set. Targets apply to the selected month. No commission rates or payments are assumed."}</p><button type="submit" className={`${button} mt-3`} disabled={busy || uncertain}>{de ? "Monatsziele speichern" : "Save monthly targets"}</button></form></details> : null}
      <details className="mt-5"><summary className="min-h-11 cursor-pointer py-3 font-semibold">{de ? "Definitionen und offene Daten" : "Definitions and unavailable data"}</summary><ul className="mt-2 space-y-3 text-sm text-stone-700">{current.definitions.map((definition) => <li key={definition.id}>{definition.text}</li>)}{current.unavailable.map((missing) => <li className="text-amber-900" key={missing}>{missing}</li>)}</ul></details>
    </>}
  </section>;
}
