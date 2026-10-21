"use client";
import { useEffect, useRef, useState } from "react";
import { salesFetch as csrfFetch } from "@/lib/security/crm-sales-client";
import type { Deal, Lead, Contact } from "@/lib/crm-types";
import { getLocale, getSalesWorkflowText, getSalesWorkflowStatusLabel, getCrmStatusLabel, type LanguageCode } from "@/lib/i18n";
import type { OfferContent, OfferLine, OfferStatus } from "@/lib/offer-workflow";

type View = { offer: { id: string; status: OfferStatus; revision: number; version: number; content: OfferContent; contentDigest: string; totalNetCents: number; followUpStatus: string; followUpAt: string | null; responseReference: string | null } | null; dealVersion: number; approval: { id: string; expiresAt: string } | null; deliveries: Array<{ id: string; status: string; revision: number; receiptReference: string | null }>; approverConfigured: boolean; canApprove: boolean };
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const button = "evelyn-domain-button min-h-11 max-w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
const field = "evelyn-domain-input min-h-11 w-full min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950";
const labels: Record<OfferStatus, string> = { DRAFT: "Entwurf", APPROVED: "Freigegeben", QUEUED: "Versand vorbereitet – nicht gesendet", SENT: "Versand manuell belegt", ACCEPTED: "Angenommen · Deal gewonnen · Kunde", REJECTED: "Abgelehnt · Deal verloren", CANCELLED: "Abgebrochen" };
/** Builds a separate document from the selected, React-escaped offer article only. */
export function createOfferPrintFrame(article: HTMLElement, status: OfferStatus): HTMLIFrameElement {
  if (!["APPROVED", "QUEUED", "SENT", "ACCEPTED", "REJECTED"].includes(status) || article.tagName !== "ARTICLE") {
    throw new Error("Nur eine freigegebene Angebotsfassung kann gedruckt werden.");
  }
  const frame = article.ownerDocument.createElement("iframe");
  const printLanguage = article.lang === "en" ? "en" : "de";
  frame.title = printLanguage === "en" ? "Isolated offer print view" : "Isolierte Angebotsfassung zum Drucken";
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:fixed;width:0;height:0;right:0;bottom:0;border:0;opacity:0;pointer-events:none";
  article.ownerDocument.body.appendChild(frame);
  const printDocument = frame.contentDocument;
  if (!printDocument || !frame.contentWindow) {
    frame.remove();
    throw new Error("Das Druckdokument konnte nicht erstellt werden.");
  }
  printDocument.title = printLanguage === "en" ? "Offer version" : "Angebotsfassung";
  printDocument.documentElement.lang = printLanguage;
  const style = printDocument.createElement("style");
  style.textContent = "@page{margin:18mm}body{margin:0;font:12pt/1.5 Arial,sans-serif;color:#111;background:#fff}article{overflow-wrap:anywhere}h4{font-size:18pt}p{white-space:pre-wrap}li{margin:0 0 8pt}ul{padding-left:20pt}";
  printDocument.head.appendChild(style);
  printDocument.body.appendChild(article.cloneNode(true));
  return frame;
}
export function OfferWorkflow({ deal, contact, leads, workspaceQuery, onChanged, language, canWrite }: { canWrite: boolean; language: LanguageCode; deal: Deal; contact?: Contact; leads: Lead[]; workspaceQuery: string; onChanged?: () => Promise<boolean | void> | boolean | void }) {
  const t = (value: string) => getSalesWorkflowText(value, language);
  const money = (cents: number) => new Intl.NumberFormat(getLocale(language), { style: "currency", currency: "EUR" }).format(cents / 100);
  const articleRef = useRef<HTMLElement | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => () => { printFrameRef.current?.remove(); }, []);
  const pendingCommand = useRef<{ body: string; key: string; correlation: string } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(deal.name);
  const [recipientName, setRecipientName] = useState(contact?.name ?? "");
  const [recipientEmail, setRecipientEmail] = useState(contact?.email ?? "");
  const [companyName, setCompanyName] = useState("");
  const [leadId, setLeadId] = useState(deal.leadId ?? "");
  const [scopeText, setScopeText] = useState("");
  const [paymentPlan, setPaymentPlan] = useState("");
  const [discounts, setDiscounts] = useState(() => t("Keine Rabatte"));
  const [specialTerms, setSpecialTerms] = useState(() => t("Keine Sonderbedingungen"));
  const [riskComplianceNotes, setRiskComplianceNotes] = useState(() => t("Keine bekannten Risiko- oder Compliance-Hinweise"));
  const [terms, setTerms] = useState("");
  const [validUntil, setValidUntil] = useState(() => localInput(new Date(Date.now() + 7 * 86400000)));
  const [items, setItems] = useState<Array<{ description: string; quantity: string; price: string }>>([{ description: "", quantity: "1", price: "" }]);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState(() => localInput(new Date(Date.now() + 3600000)));
  const [followUpAt, setFollowUpAt] = useState(() => localInput(new Date(Date.now() + 86400000)));
  const offer = view?.offer;
  const endpoint = `/api/crm/offers${workspaceQuery}`;
  useEffect(() => {
    const abort = new AbortController();
    void csrfFetch(`${endpoint}${workspaceQuery ? "&" : "?"}dealId=${encodeURIComponent(deal.id)}`, { cache: "no-store", signal: abort.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.code ?? data.error); if (!abort.signal.aborted) setView(data as View); })
      .catch(() => { if (!abort.signal.aborted) setMessage("Angebotsakte nicht verfügbar"); });
    return () => abort.abort();
  }, [deal.id, endpoint, workspaceQuery]);
  const run = async (operation: string, payload: Record<string, unknown>) => {
    if (!canWrite) return;
    setBusy(true); setMessage("");
    try {
      const body = JSON.stringify({ operation, dealId: deal.id, offerId: offer?.id, projectId: deal.projectId, expectedVersion: offer?.version ?? view?.dealVersion, payload });
      if (pendingCommand.current?.body !== body) pendingCommand.current = { body, key: crypto.randomUUID(), correlation: crypto.randomUUID() };
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pendingCommand.current.key, "X-Correlation-Id": pendingCommand.current.correlation }, body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code ?? data.error ?? "Vorgang fehlgeschlagen");
      pendingCommand.current = null;
      setView(data.data as View); setEditing(false); setReference(""); setReason(""); setMessage("Gespeichert. Kein automatischer E-Mail- oder Vertragsversand.");
      await onChanged?.();
    } catch (error) { setMessage(error instanceof Error && error.message === "FRESH_AUTHENTICATION_REQUIRED" ? "Bitte erneut anmelden und die Freigabe wiederholen." : error instanceof Error && /CONFLICT|VERSION_MISMATCH/.test(error.message) ? "Der Stand wurde inzwischen geändert. Bitte neu laden und Ihre Eingaben prüfen." : "Vorgang fehlgeschlagen"); }
    finally { setBusy(false); }
  };
  const draftContent = (): OfferContent => {
    const lines: OfferLine[] = items.map(item => {
      if (!/^\d+(?:[.,]\d{1,2})?$/.test(item.price)) throw new Error("Bitte Nettoeinzelpreise mit höchstens zwei Nachkommastellen eingeben.");
      const [whole, fraction = ""] = item.price.replace(",", ".").split(".");
      return { description: item.description, quantity: Number(item.quantity), unitNetCents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")) };
    });
    return { subject, recipientName, recipientEmail, scope: scopeText, paymentPlan, discounts, specialTerms, riskComplianceNotes, terms, validUntil: new Date(validUntil).toISOString(), currency: "EUR", taxBasis: "NET", items: lines };
  };
  const save = () => { try { void run(offer ? "revise" : "create", offer ? { content: draftContent() } : { content: draftContent(), leadId, ...(companyName.trim() ? { organizationName: companyName } : {}) }); } catch (error) { setMessage(error instanceof Error && error.message === "Bitte Nettoeinzelpreise mit höchstens zwei Nachkommastellen eingeben." ? error.message : "Ungültiger Entwurf"); } };
  const startRevision = () => {
    if (!offer) return;
    setSubject(offer.content.subject); setRecipientName(offer.content.recipientName); setRecipientEmail(offer.content.recipientEmail); setScopeText(offer.content.scope ?? offer.content.terms); setPaymentPlan(offer.content.paymentPlan ?? "Bitte Zahlungsplan ergänzen"); setDiscounts(offer.content.discounts ?? "Keine Rabatte"); setSpecialTerms(offer.content.specialTerms ?? "Keine Sonderbedingungen"); setRiskComplianceNotes(offer.content.riskComplianceNotes ?? "Keine bekannten Risiko- oder Compliance-Hinweise"); setTerms(offer.content.terms); setValidUntil(localInput(new Date(offer.content.validUntil)));
    setItems(offer.content.items.map(item => ({ description: item.description, quantity: String(item.quantity), price: (item.unitNetCents / 100).toFixed(2) }))); setEditing(true);
  };
  const printOffer = () => {
    if (!offer || !articleRef.current) return;
    try {
      printFrameRef.current?.remove();
      const frame = createOfferPrintFrame(articleRef.current, offer.status);
      printFrameRef.current = frame;
      frame.contentWindow!.addEventListener("afterprint", () => { frame.remove(); if (printFrameRef.current === frame) printFrameRef.current = null; }, { once: true });
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
    } catch { printFrameRef.current?.remove(); printFrameRef.current = null; setMessage("Druckausgabe nicht verfügbar"); }
  };
  const scope = offer ? { revision: offer.revision, contentDigest: offer.contentDigest } : {};
  const localDate = (value: string) => { const parsed = new Date(value); if (!value || !Number.isFinite(parsed.getTime())) { setMessage("Bitte ein gültiges Datum und eine Uhrzeit eingeben."); return null; } return parsed.toISOString(); };
  return <section className="min-w-0 space-y-4 rounded-xl border border-stone-200 bg-stone-50 p-4" aria-label={t("Angebotsablauf")}>
    <div><h3 className="font-semibold text-slate-950">{t("Angebot und Kundenabschluss")}</h3><p className="mt-1 text-sm text-stone-600">{t("Versionierte Angebotsakte. Vertrags- und Zahlungsversand sind nicht aktiviert.")}</p></div>
    {message && <p role="status" className="break-words rounded-lg bg-white p-3 text-sm">{t(message)}</p>}
    {!view ? <p className="text-sm">{t("Angebotsakte wird geladen. Bei einem Fehler bitte die Seite neu laden.")}</p> : <>
      {!view.approverConfigured && <p role="alert" className="rounded-lg bg-amber-100 p-3 text-sm">{t("Keine freigabeberechtigte Person konfiguriert. Entwürfe sind möglich; Freigabe und Versand bleiben gesperrt.")}</p>}
      {offer && <div className="space-y-1 text-sm"><strong>{t(labels[offer.status])}</strong><p>Revision {offer.revision} · {money(offer.totalNetCents)} {t("netto")}</p><p>{t("Nachfassen:")} {getSalesWorkflowStatusLabel(offer.followUpStatus, language)}{offer.followUpAt ? ` · ${new Date(offer.followUpAt).toLocaleString(getLocale(language))}` : ""}</p>{offer.responseReference && <p className="break-words">{t("Antwortbeleg:")} {offer.responseReference}</p>}</div>}
      {canWrite && (!offer || editing) && <form className="space-y-3" onSubmit={event => { event.preventDefault(); save(); }}>
        {!offer && <><label className="block text-sm">{t("Zugehöriger Lead")}<select className={field} value={leadId} required onChange={event => setLeadId(event.target.value)}><option value="">{t("Lead auswählen")}</option>{leads.filter(lead => lead.contactId === deal.contactId && lead.projectId === deal.projectId).map(lead => <option key={lead.id} value={lead.id}>{lead.intent} · {getCrmStatusLabel(lead.status, language)}</option>)}</select></label>{!deal.organizationId && !contact?.organizationId && <label className="block text-sm">{t("Unternehmen des Kunden")}<input className={field} value={companyName} required onChange={event => setCompanyName(event.target.value)} /></label>}</>}
        <label className="block text-sm">{t("Betreff")}<input className={field} value={subject} required onChange={event => setSubject(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">{t("Empfängername")}<input className={field} value={recipientName} required onChange={event => setRecipientName(event.target.value)} /></label><label className="block text-sm">{t("Empfänger-E-Mail")}<input className={field} type="email" value={recipientEmail} required onChange={event => setRecipientEmail(event.target.value)} /></label></div>
        <fieldset className="space-y-3"><legend className="text-sm font-semibold">{t("Positionen · EUR netto · gesamte Verpflichtung")}</legend>{items.map((item, index) => <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4"><label className="text-sm sm:col-span-2">{t("Leistung")}<input className={field} value={item.description} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, description: event.target.value } : line))} /></label><label className="text-sm">{t("Anzahl")}<input className={field} type="number" min="1" step="1" value={item.quantity} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, quantity: event.target.value } : line))} /></label><label className="text-sm">{t("Einzelpreis (€)")}<input className={field} inputMode="decimal" value={item.price} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, price: event.target.value } : line))} /></label>{items.length > 1 && <button className={button} type="button" onClick={() => setItems(current => current.filter((_, n) => n !== index))}>{t("Position entfernen")}</button>}</div>)}<button className={button} type="button" disabled={items.length >= 100} onClick={() => setItems(current => [...current, { description: "", quantity: "1", price: "" }])}>{t("Position ergänzen")}</button></fieldset>
        <label className="block text-sm">{t("Leistungsumfang")}<textarea aria-label={t("Leistungsumfang")} className={field} rows={4} value={scopeText} required onChange={event => setScopeText(event.target.value)} /></label>
        <label className="block text-sm">{t("Zahlungsplan")}<textarea aria-label={t("Zahlungsplan")} className={field} rows={3} value={paymentPlan} required onChange={event => setPaymentPlan(event.target.value)} /></label>
        <label className="block text-sm">{t("Rabatte")}<textarea aria-label={t("Rabatte")} className={field} rows={2} value={discounts} required onChange={event => setDiscounts(event.target.value)} /></label>
        <label className="block text-sm">{t("Sonderbedingungen")}<textarea aria-label={t("Sonderbedingungen")} className={field} rows={3} value={specialTerms} required onChange={event => setSpecialTerms(event.target.value)} /></label>
        <label className="block text-sm">{t("Risiko- und Compliance-Hinweise")}<textarea aria-label={t("Risiko- und Compliance-Hinweise")} className={field} rows={3} value={riskComplianceNotes} required onChange={event => setRiskComplianceNotes(event.target.value)} /></label>
        <label className="block text-sm">{t("Weitere Konditionen")}<textarea aria-label={t("Weitere Konditionen")} className={field} rows={4} value={terms} required onChange={event => setTerms(event.target.value)} /></label><label className="block text-sm">{t("Gültig bis (lokale Zeit)")}<input className={field} type="datetime-local" value={validUntil} required onChange={event => setValidUntil(event.target.value)} /></label>
        <p className="text-sm">{t("Wiederkehrende Leistungen mit allen verpflichtenden Perioden als Anzahl aufnehmen. Jede Änderung erfordert eine neue Freigabe.")}</p><button className={button} disabled={busy} type="submit">{offer ? t("Neue Revision speichern") : t("Angebotsentwurf anlegen")}</button>{editing && <button className={button} type="button" onClick={() => setEditing(false)}>{t("Abbrechen")}</button>}
      </form>}
      {offer && !editing && <>
        <details className="rounded-lg bg-white p-3" open><summary className="min-h-11 cursor-pointer font-semibold">{t("Exakte Fassung · Revision")} {offer.revision}</summary><article lang={language} ref={articleRef} className="space-y-3 break-words"><h4 className="text-lg font-semibold">{offer.content.subject}</h4><p>{t("An")} {offer.content.recipientName} · {offer.content.recipientEmail}</p><p className="whitespace-pre-wrap"><strong>{t("Leistungsumfang")}:</strong> {offer.content.scope}</p><ul className="space-y-2">{offer.content.items.map((item, index) => <li key={index}>{item.quantity} × {item.description} · {money(item.unitNetCents)} {t("netto")} = {money(item.quantity * item.unitNetCents)} {t("netto")}</li>)}</ul><p className="font-semibold">{t("Gesamtverpflichtung:")} {money(offer.totalNetCents)} {t("netto")}</p><p className="whitespace-pre-wrap"><strong>{t("Zahlungsplan")}:</strong> {offer.content.paymentPlan}</p><p className="whitespace-pre-wrap"><strong>{t("Rabatte")}:</strong> {offer.content.discounts}</p><p className="whitespace-pre-wrap"><strong>{t("Sonderbedingungen")}:</strong> {offer.content.specialTerms}</p><p className="whitespace-pre-wrap"><strong>{t("Risiko/Compliance:")}</strong> {offer.content.riskComplianceNotes}</p><p className="whitespace-pre-wrap">{offer.content.terms}</p><p>{t("Gültig bis")} {new Date(offer.content.validUntil).toLocaleString(getLocale(language))}</p><p className="break-all text-xs">{t("Inhaltsnachweis:")} {offer.contentDigest}</p></article></details>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !["APPROVED", "QUEUED", "SENT", "ACCEPTED", "REJECTED"].includes(offer.status)} onClick={printOffer}>{offer.status === "DRAFT" ? t("Entwurf – Druck erst nach Freigabe") : t("Fassung drucken")}</button>{canWrite && ["DRAFT", "APPROVED", "SENT"].includes(offer.status) && <button className={button} disabled={busy} onClick={startRevision}>{t("Neue Revision bearbeiten")}</button>}</div>
        {canWrite && offer.status === "DRAFT" && <div className="space-y-2"><label className="block text-sm">{t("Freigabe gültig bis (lokale Zeit)")}<input className={field} type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label><button className={button} disabled={busy || !view.canApprove} onClick={() => { const date = localDate(expiresAt); if (date) void run("approve", { ...scope, expiresAt: date }); }}>{t("Diese Revision freigeben")}</button><p className="text-xs">{t("Nur die konfigurierte Owner-Person (A3) mit höchstens 15 Minuten alter Anmeldung. Bei FRESH_AUTHENTICATION_REQUIRED erneut anmelden.")}</p></div>}
        {canWrite && offer.status === "APPROVED" && <button className={button} disabled={busy} onClick={() => void run("queue_send", {})}>{t("Manuellen Versand vorbereiten")}</button>}
        {canWrite && ["QUEUED", "SENT"].includes(offer.status) && <label className="block text-sm">{offer.status === "QUEUED" ? t("Manueller Versandbeleg (z. B. Referenz des gesendeten E-Mails)") : t("Kundenantwort / Annahme- oder Ablehnungsbeleg")}<input className={field} value={reference} onChange={event => setReference(event.target.value)} /></label>}
        {canWrite && offer.status === "QUEUED" && <div className="space-y-2"><p className="text-sm">{t("Die freigegebene Fassung selbst an den ausgewiesenen Empfänger senden. Erst danach den Versand belegen. Das CRM bestätigt keine Providerzustellung.")}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("record_sent", { ...scope, recipientEmail: offer.content.recipientEmail, reference, sentAt: new Date().toISOString() })}>{t("Manuellen Versand bestätigen")}</button><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("record_unknown", { ...scope, recipientEmail: offer.content.recipientEmail, reference })}>{t("Versandausgang unklar")}</button></div></div>}
        {canWrite && (["APPROVED", "QUEUED"].includes(offer.status) || offer.status === "SENT") && <label className="block text-sm">{t("Begründung / Gesprächsnotiz")}<textarea className={field} value={reason} onChange={event => setReason(event.target.value)} /></label>}
        {canWrite && ["APPROVED", "QUEUED"].includes(offer.status) && <button className={button} disabled={busy || !view.canApprove || !reason.trim()} onClick={() => void run("revoke", { reason })}>{t("Freigabe widerrufen")}</button>}
        {canWrite && offer.status === "SENT" && <div className="space-y-3"><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("accept", { ...scope, reference })}>{t("Kundenannahme belegen")}</button><button className={button} disabled={busy || !reference.trim() || !reason.trim()} onClick={() => void run("reject", { ...scope, reference, reason })}>{t("Kundenablehnung belegen")}</button></div><label className="block text-sm">{t("Nächstes Nachfassen (lokale Zeit)")}<input className={field} type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} /></label><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || offer.followUpStatus === "SCHEDULED"} onClick={() => { const date = localDate(followUpAt); if (date) void run("schedule_follow_up", { dueAt: date }); }}>{t("Nachfassaufgabe planen")}</button><button className={button} disabled={busy || offer.followUpStatus !== "SCHEDULED" || !reason.trim()} onClick={() => void run("stop_follow_up", { reason })}>{t("Nachfassen stoppen")}</button><button className={button} disabled={busy || offer.followUpStatus !== "SCHEDULED" || !reason.trim()} onClick={() => void run("complete_follow_up", { reason })}>{t("Nachfassen dokumentieren")}</button></div><p className="text-xs">{t("Aufgabe für manuelle Kontaktaufnahme. Annahme und Ablehnung stoppen offene Nachfassaufgaben atomar.")}</p></div>}
        {view.deliveries.length > 0 && <ul className="space-y-1 text-xs">{view.deliveries.map(delivery => <li key={delivery.id} className="break-words">Revision {delivery.revision}: {delivery.status === "MANUALLY_ATTESTED" ? t("Manuell belegt – Providerzustellung nicht geprüft") : delivery.status === "QUEUED" ? t("Vorbereitet – nicht gesendet") : getSalesWorkflowStatusLabel(delivery.status, language)}{delivery.receiptReference ? ` · ${delivery.receiptReference}` : ""}</li>)}</ul>}
      </>}
    </>}
  </section>;
}
