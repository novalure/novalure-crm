"use client";

import { useEffect, useRef, useState } from "react";
import { AI_PLAN_CATALOG, AI_TOPUP_CATALOG } from "@/lib/ai-billing/catalog";
import type { AiBookingRequest } from "@/lib/ai-billing/repository";
import { csrfFetch } from "@/lib/security/csrf-client";

type AdminRequest = AiBookingRequest & { workspaceId: string; workspaceName: string; requesterName: string; requesterEmail: string };
type Overview = { source: "database"; canAdmin: true; requests: AdminRequest[]; reservations: { id: string; workspaceName: string; reservedCredits: number; createdAt: string }[] };
type Choice = { request: AdminRequest; action: "fulfill" | "close"; status?: "fulfilled" | "cancelled" };
type PendingAction = { body: string; idempotencyKey: string };
const words = {
  de: { title: "Buchungsfreigaben", description: "KI-Pakete, Zusatzguthaben und Website-Anfragen aller Unternehmen prüfen. Freigaben erfolgen manuell; es wird keine Zahlung ausgelöst.", refresh: "Aktualisieren", loading: "Buchungsanfragen werden geladen …", unavailable: "Die interne Buchungsverwaltung ist nicht verfügbar. Zugang und Verbindung prüfen.", retry: "Erneut laden", filter: "Anfragestatus", pending: "In Prüfung", fulfilled: "Bearbeitet", cancelled: "Abgelehnt", empty: "Keine Anfragen in diesem Status.", requester: "Angefragt von", plan: "KI-Paket", topup: "Zusatzguthaben", website: "Makler-Website & Betreuung", quote: "Individuelles Angebot", approve: "Buchung freigeben", complete: "Als bearbeitet markieren", reject: "Anfrage ablehnen", review: "Freigabe prüfen", company: "Unternehmen", amount: "Vereinbarter Betrag", monthly: "netto pro Monat", once: "netto einmalig", reference: "Rechnungs-, Vertrags- oder Prüfbeleg", referenceHint: "Zum Beispiel Rechnungsnummer oder bestätigtes Angebot", until: "Bezahlt bis (UTC, erster Tag des Folgemonats)", periodHint: "Das KI-Kontingent gilt je UTC-Kalendermonat. Der erste Teilmonat wird vor der Freigabe mit dem Kunden vereinbart.", confirm: "Ich habe Unternehmen, Anfrage, Konditionen und Beleg geprüft. Diese Änderung soll jetzt gespeichert werden.", activate: "Freigabe bestätigen", close: "Status bestätigen", back: "Zurück", sending: "Wird gespeichert …", saved: "Die Änderung wurde bestätigt und gespeichert.", failed: "Die Änderung konnte nicht bestätigt werden. Eingaben und aktuellen Status prüfen.", uncertain: "Das Ergebnis ist noch ungeklärt. Nur denselben Vorgang erneut prüfen; die Anfragekennung bleibt erhalten.", same: "Denselben Vorgang erneut prüfen", reservations: "Zur Prüfung vorgemerkte KI-Aufträge", reservationHint: "Diese Credits bleiben reserviert, bis der tatsächliche Anbieterbeleg geprüft wurde. Keine pauschale Erstattung bei unbekanntem Ergebnis.", credits: "Credits reserviert", noCharge: "Die Freigabe aktiviert die gespeicherte Buchung. Eine Abbuchung oder Stripe-Zahlung erfolgt nicht.", noGrant: "Diese Statusänderung vergibt keine KI-Credits.", included: "KI inklusive", date: "Angefragt am" },
  en: { title: "Booking approvals", description: "Review AI packages, additional credits and website enquiries across companies. Approval is manual and does not initiate a payment.", refresh: "Refresh", loading: "Loading booking requests …", unavailable: "Internal billing administration is unavailable. Check your access and connection.", retry: "Try again", filter: "Request status", pending: "Under review", fulfilled: "Processed", cancelled: "Declined", empty: "No requests with this status.", requester: "Requested by", plan: "AI package", topup: "Additional credits", website: "Agency website & maintenance", quote: "Individual quote", approve: "Approve booking", complete: "Mark as processed", reject: "Decline request", review: "Review approval", company: "Company", amount: "Agreed amount", monthly: "net per month", once: "net, one-off", reference: "Invoice, contract or review reference", referenceHint: "For example, an invoice number or confirmed quote", until: "Paid through (UTC, first day of the following month)", periodHint: "AI allowances apply per UTC calendar month. Agree the initial partial month with the customer before approval.", confirm: "I have checked the company, request, terms and reference. Save this change now.", activate: "Confirm approval", close: "Confirm status", back: "Back", sending: "Saving …", saved: "The change has been confirmed and saved.", failed: "The change could not be confirmed. Check the inputs and current status.", uncertain: "The outcome is unknown. Retry only the same operation; its request identifier is preserved.", same: "Retry the same operation", reservations: "AI requests awaiting review", reservationHint: "These credits stay reserved until the actual provider receipt has been checked. Never refund an unknown result without verification.", credits: "credits reserved", noCharge: "Approval activates the saved booking. No charge or Stripe payment is initiated.", noGrant: "This status change does not grant AI credits.", included: "AI included", date: "Requested on" },
  es: { title: "Aprobaciones de contratación", description: "Revise paquetes de IA, créditos adicionales y solicitudes web de todas las empresas. La aprobación es manual y no inicia ningún pago.", refresh: "Actualizar", loading: "Cargando solicitudes …", unavailable: "La administración interna no está disponible. Compruebe su acceso y conexión.", retry: "Reintentar", filter: "Estado de solicitud", pending: "En revisión", fulfilled: "Tramitada", cancelled: "Rechazada", empty: "No hay solicitudes con este estado.", requester: "Solicitado por", plan: "Paquete de IA", topup: "Créditos adicionales", website: "Web inmobiliaria y mantenimiento", quote: "Presupuesto individual", approve: "Aprobar contratación", complete: "Marcar como tramitada", reject: "Rechazar solicitud", review: "Revisar aprobación", company: "Empresa", amount: "Importe acordado", monthly: "netos al mes", once: "netos, pago único", reference: "Referencia de factura, contrato o revisión", referenceHint: "Por ejemplo, el número de factura o presupuesto confirmado", until: "Pagado hasta (UTC, primer día del mes siguiente)", periodHint: "La asignación de IA se aplica por mes natural UTC. Acuerde el primer mes parcial con el cliente antes de aprobar.", confirm: "He comprobado la empresa, solicitud, condiciones y referencia. Guardar ahora este cambio.", activate: "Confirmar aprobación", close: "Confirmar estado", back: "Volver", sending: "Guardando …", saved: "El cambio se ha confirmado y guardado.", failed: "No se ha podido confirmar el cambio. Compruebe los datos y el estado actual.", uncertain: "El resultado se desconoce. Reintente solo la misma operación; se conserva su identificador.", same: "Reintentar la misma operación", reservations: "Solicitudes de IA pendientes de revisión", reservationHint: "Los créditos permanecen reservados hasta comprobar el justificante del proveedor. No reembolse un resultado desconocido sin verificarlo.", credits: "créditos reservados", noCharge: "La aprobación activa la contratación guardada. No se inicia ningún cargo ni pago de Stripe.", noGrant: "Este cambio de estado no concede créditos de IA.", included: "IA incluida", date: "Fecha de solicitud" },
} as const;
const card = "min-w-0 rounded-xl border border-stone-200 bg-white p-5";
const button = "min-h-11 rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50";
const field = "min-h-11 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-900";
function nextMonth() { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); }

export function AiBillingAdminPanel(props: { workspaceId: string; language: string }) {
  return <AiBillingAdminContent key={props.workspaceId} {...props} />;
}

function AiBillingAdminContent({ workspaceId, language }: { workspaceId: string; language: string }) {
  const lang = language === "de" || language === "es" ? language : "en", text = words[lang];
  const locale = lang === "de" ? "de-AT" : lang === "es" ? "es-ES" : "en-IE";
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(value / 100);
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)) : "—";
  const label = (row: AdminRequest) => row.kind === "website" ? text.website : row.kind === "plan" ? row.itemId === "included" ? text.included : AI_PLAN_CATALOG.find(plan => plan.id === row.itemId)?.name ?? text.plan : `${new Intl.NumberFormat(locale).format(AI_TOPUP_CATALOG.find(pack => pack.id === row.itemId)?.credits ?? 0)} ${text.topup}`;
  const [data, setData] = useState<Overview | null>(null), [failed, setFailed] = useState(false), [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<"pending" | "fulfilled" | "cancelled">("pending");
  const [choice, setChoice] = useState<Choice | null>(null), [reference, setReference] = useState(""), [paidUntil, setPaidUntil] = useState(nextMonth), [reviewed, setReviewed] = useState(false), [selectedAt] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingAction | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<"saved" | "failed" | "uncertain" | null>(null);
  const pendingRef = useRef<PendingAction | null>(null), inFlight = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const endpoint = `/api/admin/ai-billing?${new URLSearchParams({ workspaceId })}`;

  useEffect(() => {
    const controller = new AbortController();
    void csrfFetch(`${endpoint}&status=${status}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json() as { data?: Overview; persisted?: boolean };
      if (!response.ok || payload.persisted !== true || payload.data?.source !== "database" || payload.data.canAdmin !== true) throw new Error("unavailable");
      if (!controller.signal.aborted) { setData(payload.data); setFailed(false); }
    }).catch(() => { if (!controller.signal.aborted) { setData(null); setFailed(true); } });
    return () => controller.abort();
  }, [endpoint, status, refresh]);
  useEffect(() => { if (choice) heading.current?.focus(); }, [choice]);

  function reload() { setData(null); setFailed(false); setRefresh(value => value + 1); }
  function select(request: AdminRequest, action: Choice["action"], nextStatus?: Choice["status"]) {
    if (inFlight.current || pendingRef.current) return;
    setChoice({ request, action, ...(nextStatus ? { status: nextStatus } : {}) }); setReference(""); setReviewed(false); setPaidUntil(nextMonth()); setNotice(null);
  }
  const needsPeriod = choice?.action === "fulfill" && choice.request.kind === "plan" && choice.request.itemId !== "included";
  const period = new Date(`${paidUntil}T00:00:00.000Z`);
  const validPeriod = !needsPeriod || (Number.isFinite(period.getTime()) && period.getUTCDate() === 1 && period.getTime() > selectedAt);
  const valid = reviewed && reference.trim().length >= 3 && reference.trim().length <= 200 && !/[\u0000-\u001f\u007f]/u.test(reference) && validPeriod;
  async function submit() {
    if (!choice || inFlight.current || (!pendingRef.current && !valid)) return;
    const operation = pendingRef.current ?? { idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ action: choice.action, requestId: choice.request.id, reference: reference.trim(), ...(choice.action === "close" ? { status: choice.status } : needsPeriod ? { paidThrough: period.toISOString() } : {}) }) };
    pendingRef.current = operation; setPending(operation); inFlight.current = true; setBusy(true); setNotice(null);
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": operation.idempotencyKey }, body: operation.body });
      const payload = await response.json() as { persisted?: boolean };
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408) { setNotice("uncertain"); return; }
        pendingRef.current = null; setPending(null); setNotice("failed"); return;
      }
      if (payload.persisted !== true) { setNotice("uncertain"); return; }
      pendingRef.current = null; setPending(null); setChoice(null); setReference(""); setReviewed(false); setNotice("saved"); reload();
    } catch { setNotice("uncertain"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="grid min-w-0 gap-4" aria-label={text.title} data-ai-billing-admin>
    <header className={card}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold text-slate-950">{text.title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{text.description}</p></div><button type="button" className={button} disabled={busy || !!pending} onClick={reload}>{text.refresh}</button></div></header>
    {notice ? <p role={notice === "saved" ? "status" : "alert"} className={`${card} ${notice === "saved" ? "bg-emerald-50" : "bg-amber-50"}`}>{text[notice]}</p> : null}
    {failed ? <div className={card} role="alert"><p>{text.unavailable}</p><button type="button" className={`${button} mt-3`} disabled={busy || !!pending} onClick={reload}>{text.retry}</button></div> : !data ? <p className={card} role="status">{text.loading}</p> : <>
      <label className="grid max-w-sm gap-2 text-sm font-semibold text-slate-900">{text.filter}<select className={field} value={status} disabled={busy || !!pending} onChange={event => { setStatus(event.target.value as typeof status); setData(null); setChoice(null); }}><option value="pending">{text.pending}</option><option value="fulfilled">{text.fulfilled}</option><option value="cancelled">{text.cancelled}</option></select></label>
      <div className="grid min-w-0 gap-3">{data.requests.length ? data.requests.map(row => <article key={row.id} className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-lg font-semibold text-slate-950">{row.workspaceName}</h3><p className="mt-1 font-semibold text-slate-900">{label(row)}</p><p className="mt-2 break-words text-sm text-stone-600">{text.requester}: {row.requesterName} · {row.requesterEmail}</p><p className="mt-1 text-sm text-stone-600">{text.date}: {date(row.createdAt)}</p></div><p className="text-lg font-semibold text-slate-900">{row.amountCents === null ? text.quote : money(row.amountCents)}{row.amountCents !== null ? <span className="mt-1 block text-xs font-normal text-stone-600">{row.kind === "plan" ? text.monthly : text.once}</span> : null}</p></div>
        {row.notes ? <p className="mt-3 whitespace-pre-wrap break-words text-sm text-stone-700">{row.notes}</p> : null}
        {row.status === "pending" ? <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !!pending} onClick={() => select(row, row.kind === "website" ? "close" : "fulfill", row.kind === "website" ? "fulfilled" : undefined)}>{row.kind === "website" ? text.complete : text.approve}</button><button type="button" className={button} disabled={busy || !!pending} onClick={() => select(row, "close", "cancelled")}>{text.reject}</button></div> : <p className="mt-3 text-sm font-semibold text-stone-700">{row.status === "fulfilled" ? text.fulfilled : text.cancelled}</p>}
      </article>) : <p className={card}>{text.empty}</p>}</div>
      {choice ? <section className="rounded-xl border-2 border-emerald-700 bg-emerald-50 p-5" aria-labelledby="ai-admin-confirm-title"><h3 id="ai-admin-confirm-title" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{text.review}</h3><dl className="mt-4 grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-stone-600">{text.company}</dt><dd className="break-words font-semibold">{choice.request.workspaceName}</dd></div><div><dt className="text-xs text-stone-600">{text.amount}</dt><dd className="font-semibold">{choice.request.amountCents === null ? text.quote : money(choice.request.amountCents)}</dd></div></dl><p className="mt-3 font-semibold">{label(choice.request)} · {choice.action === "fulfill" ? text.approve : choice.status === "fulfilled" ? text.complete : text.reject}</p><p className="mt-3 text-sm leading-6 text-stone-700">{choice.action === "fulfill" ? text.noCharge : text.noGrant}</p>
        <fieldset className="mt-4 grid gap-4" disabled={busy || !!pending}><label className="grid gap-2 text-sm font-semibold">{text.reference}<input className={field} maxLength={200} value={reference} placeholder={text.referenceHint} onChange={event => setReference(event.target.value)} /></label>{needsPeriod ? <label className="grid gap-2 text-sm font-semibold">{text.until}<input className={field} type="date" value={paidUntil} onChange={event => setPaidUntil(event.target.value)} /><span className="text-sm font-normal leading-6 text-stone-600">{text.periodHint}</span></label> : null}<label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1 h-4 w-4 shrink-0 accent-emerald-800" type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{text.confirm}</label></fieldset>
        <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="min-h-11 rounded-md bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || (!pending && !valid)} onClick={() => void submit()}>{busy ? text.sending : pending ? text.same : choice.action === "fulfill" ? text.activate : text.close}</button><button type="button" className={button} disabled={busy || !!pending} onClick={() => { setChoice(null); setReviewed(false); setNotice(null); }}>{text.back}</button></div>
      </section> : null}
      {data.reservations.length ? <article className={card}><h3 className="text-lg font-semibold">{text.reservations}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{text.reservationHint}</p><ul className="mt-3 grid gap-2">{data.reservations.map(row => <li className="flex flex-wrap justify-between gap-2 rounded-md bg-stone-50 p-3 text-sm" key={row.id}><span className="break-words font-semibold">{row.workspaceName}</span><span>{new Intl.NumberFormat(locale).format(row.reservedCredits)} {text.credits}</span></li>)}</ul></article> : null}
    </>}
  </section>;
}
