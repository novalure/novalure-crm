"use client";
import { useEffect, useRef, useState } from "react";
import { salesFetch as csrfFetch } from "@/lib/security/crm-sales-client";
import type { Deal, Lead, Contact } from "@/lib/crm-types";
import type { CompleteFinancialSnapshotV1, FinancialSnapshotV1, MoneyV2 } from "@/lib/evelyn-money-tax-v2";
import type { OfferContent, OfferLine, OfferStatus } from "@/lib/offer-workflow";

type View = { offer: { id: string; status: OfferStatus; revision: number; version: number; content: OfferContent; contentDigest: string; totalNetCents: number; followUpStatus: string; followUpAt: string | null; responseReference: string | null } | null; dealVersion: number; approval: { id: string; expiresAt: string } | null; deliveries: Array<{ id: string; status: string; revision: number; receiptReference: string | null }>; approverConfigured: boolean; canApprove: boolean };
type OfferFinancialSnapshot = { id: string; reviewState: "NEEDS_REVIEW" | "VERIFIED"; snapshotHash: string; snapshot: FinancialSnapshotV1 };
type AuthoritativeOfferFinancialSnapshot = Omit<OfferFinancialSnapshot, "reviewState" | "snapshot"> & {
  reviewState: "VERIFIED";
  snapshot: CompleteFinancialSnapshotV1;
};
function isAuthoritativeOfferFinancialSnapshot(
  value: OfferFinancialSnapshot | null | undefined,
): value is AuthoritativeOfferFinancialSnapshot {
  return value?.reviewState === "VERIFIED" && value.snapshot.reviewState === "COMPLETE";
}
const exactMoney = (value: MoneyV2) => {
  const negative = value.minorUnits.startsWith("-");
  const unsigned = negative ? value.minorUnits.slice(1) : value.minorUnits;
  const padded = unsigned.padStart(value.minorUnitExponent + 1, "0");
  const integerDigits = value.minorUnitExponent === 0 ? padded : padded.slice(0, -value.minorUnitExponent);
  const fraction = value.minorUnitExponent === 0 ? "" : padded.slice(-value.minorUnitExponent);
  const integer = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 0 }).format(BigInt(integerDigits));
  return `${value.currency} ${negative ? "-" : ""}${integer}${fraction ? `,${fraction}` : ""}`;
};
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const button = "min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
const field = "min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950";
const labels: Record<OfferStatus, string> = { DRAFT: "Entwurf", APPROVED: "Freigegeben", QUEUED: "Versand vorbereitet – nicht gesendet", SENT: "Versand manuell belegt", ACCEPTED: "Angenommen · Deal gewonnen · Kunde", REJECTED: "Abgelehnt · Deal verloren", CANCELLED: "Abgebrochen" };
/** Builds a separate document from the selected, React-escaped offer article only. */
export function createOfferPrintFrame(article: HTMLElement, status: OfferStatus): HTMLIFrameElement {
  if (!["APPROVED", "QUEUED", "SENT", "ACCEPTED", "REJECTED"].includes(status) || article.tagName !== "ARTICLE") {
    throw new Error("Nur eine freigegebene Angebotsfassung kann gedruckt werden.");
  }
  const frame = article.ownerDocument.createElement("iframe");
  frame.title = "Isolierte Angebotsfassung zum Drucken";
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:fixed;width:0;height:0;right:0;bottom:0;border:0;opacity:0;pointer-events:none";
  article.ownerDocument.body.appendChild(frame);
  const printDocument = frame.contentDocument;
  if (!printDocument || !frame.contentWindow) {
    frame.remove();
    throw new Error("Das Druckdokument konnte nicht erstellt werden.");
  }
  printDocument.title = "Angebotsfassung";
  printDocument.documentElement.lang = "de";
  const style = printDocument.createElement("style");
  style.textContent = "@page{margin:18mm}body{margin:0;font:12pt/1.5 Arial,sans-serif;color:#111;background:#fff}article{overflow-wrap:anywhere}h4{font-size:18pt}p{white-space:pre-wrap}li{margin:0 0 8pt}ul{padding-left:20pt}";
  printDocument.head.appendChild(style);
  printDocument.body.appendChild(article.cloneNode(true));
  return frame;
}
export function OfferWorkflow({ deal, contact, leads, workspaceQuery, onChanged }: { deal: Deal; contact?: Contact; leads: Lead[]; workspaceQuery: string; onChanged?: () => Promise<boolean | void> | boolean | void }) {
  const articleRef = useRef<HTMLElement | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => () => { printFrameRef.current?.remove(); }, []);
  const pendingCommand = useRef<{ body: string; key: string; correlation: string } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [financialSnapshotResult, setFinancialSnapshotResult] = useState<{
    key: string;
    snapshot: OfferFinancialSnapshot | null;
  }>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(deal.name);
  const [recipientName, setRecipientName] = useState(contact?.name ?? "");
  const [recipientEmail, setRecipientEmail] = useState(contact?.email ?? "");
  const [companyName, setCompanyName] = useState("");
  const [leadId, setLeadId] = useState(deal.leadId ?? "");
  const [terms, setTerms] = useState("");
  const [validUntil, setValidUntil] = useState(() => localInput(new Date(Date.now() + 7 * 86400000)));
  const [items, setItems] = useState<Array<{ description: string; quantity: string; price: string }>>([{ description: "", quantity: "1", price: "" }]);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState(() => localInput(new Date(Date.now() + 3600000)));
  const [followUpAt, setFollowUpAt] = useState(() => localInput(new Date(Date.now() + 86400000)));
  const offer = view?.offer;
  const offerId = offer?.id;
  const financialSnapshotKey = offer ? `${offer.id}:${offer.revision}:${offer.contentDigest}` : undefined;
  const financialSnapshot = financialSnapshotResult && financialSnapshotResult.key === financialSnapshotKey
    ? financialSnapshotResult.snapshot
    : undefined;
  const endpoint = `/api/crm/offers${workspaceQuery}`;
  useEffect(() => {
    const abort = new AbortController();
    void csrfFetch(`${endpoint}${workspaceQuery ? "&" : "?"}dealId=${encodeURIComponent(deal.id)}`, { cache: "no-store", signal: abort.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.code ?? data.error); if (!abort.signal.aborted) setView(data as View); })
      .catch(error => { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Angebotsakte nicht verfügbar"); });
    return () => abort.abort();
  }, [deal.id, endpoint, workspaceQuery]);
  useEffect(() => {
    if (!offerId || !financialSnapshotKey) return;
    const abort = new AbortController();
    const separator = workspaceQuery ? "&" : "?";
    void csrfFetch(`/api/crm/financial-snapshots${workspaceQuery}${separator}offerId=${encodeURIComponent(offerId)}`, {
      cache: "no-store",
      signal: abort.signal,
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.code ?? data.error);
      if (!abort.signal.aborted) setFinancialSnapshotResult({
        key: financialSnapshotKey,
        snapshot: (data.snapshot ?? null) as OfferFinancialSnapshot | null,
      });
    }).catch(error => {
      if (!abort.signal.aborted) {
        setFinancialSnapshotResult({ key: financialSnapshotKey, snapshot: null });
        setMessage(error instanceof Error ? error.message : "Finanzsnapshot nicht verfügbar");
      }
    });
    return () => abort.abort();
  }, [financialSnapshotKey, offerId, workspaceQuery]);
  const run = async (operation: string, payload: Record<string, unknown>) => {
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
    } catch (error) { setMessage(error instanceof Error ? error.message : "Vorgang fehlgeschlagen"); }
    finally { setBusy(false); }
  };
  const draftContent = (): OfferContent => {
    const lines: OfferLine[] = items.map(item => {
      if (!/^\d+(?:[.,]\d{1,2})?$/.test(item.price)) throw new Error("Bitte Nettoeinzelpreise mit höchstens zwei Nachkommastellen eingeben.");
      const [whole, fraction = ""] = item.price.replace(",", ".").split(".");
      return { description: item.description, quantity: Number(item.quantity), unitNetCents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")) };
    });
    return { subject, recipientName, recipientEmail, terms, validUntil: new Date(validUntil).toISOString(), currency: "EUR", taxBasis: "NET", items: lines };
  };
  const save = () => { try { void run(offer ? "revise" : "create", offer ? { content: draftContent() } : { content: draftContent(), leadId, ...(companyName.trim() ? { organizationName: companyName } : {}) }); } catch (error) { setMessage(error instanceof Error ? error.message : "Ungültiger Entwurf"); } };
  const startRevision = () => {
    if (!offer) return;
    setSubject(offer.content.subject); setRecipientName(offer.content.recipientName); setRecipientEmail(offer.content.recipientEmail); setTerms(offer.content.terms); setValidUntil(localInput(new Date(offer.content.validUntil)));
    setItems(offer.content.items.map(item => ({ description: item.description, quantity: String(item.quantity), price: (item.unitNetCents / 100).toFixed(2) }))); setEditing(true);
  };
  const printOffer = () => {
    if (!offer || !articleRef.current) return;
    if (financialSnapshot?.reviewState !== "VERIFIED" || financialSnapshot.snapshot.reviewState !== "COMPLETE") {
      setMessage("Druck gesperrt: Es liegt kein vollständig verifizierter Finanzsnapshot vor.");
      return;
    }
    try {
      printFrameRef.current?.remove();
      const frame = createOfferPrintFrame(articleRef.current, offer.status);
      printFrameRef.current = frame;
      frame.contentWindow!.addEventListener("afterprint", () => { frame.remove(); if (printFrameRef.current === frame) printFrameRef.current = null; }, { once: true });
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
    } catch (error) { printFrameRef.current?.remove(); printFrameRef.current = null; setMessage(error instanceof Error ? error.message : "Druckausgabe nicht verfügbar"); }
  };
  const scope = offer ? { revision: offer.revision, contentDigest: offer.contentDigest } : {};
  const authoritativeFinancialSnapshot = isAuthoritativeOfferFinancialSnapshot(financialSnapshot)
    ? financialSnapshot
    : null;
  const localDate = (value: string) => { const parsed = new Date(value); if (!value || !Number.isFinite(parsed.getTime())) { setMessage("Bitte ein gültiges Datum und eine Uhrzeit eingeben."); return null; } return parsed.toISOString(); };
  return <section className="min-w-0 space-y-4 rounded-xl border border-stone-200 bg-stone-50 p-4" aria-label="Angebotsablauf">
    <div><h3 className="font-semibold text-slate-950">Angebot und Kundenabschluss</h3><p className="mt-1 text-sm text-stone-600">Versionierte Angebotsakte. Vertrags- und Zahlungsversand sind nicht aktiviert.</p></div>
    {message && <p role="status" className="break-words rounded-lg bg-white p-3 text-sm">{message}</p>}
    {!view ? <p className="text-sm">Angebotsakte wird geladen. Bei einem Fehler bitte die Seite neu laden.</p> : <>
      {!view.approverConfigured && <p role="alert" className="rounded-lg bg-amber-100 p-3 text-sm">Keine freigabeberechtigte Person konfiguriert. Entwürfe sind möglich; Freigabe und Versand bleiben gesperrt.</p>}
      {offer && <div className="space-y-1 text-sm"><strong>{labels[offer.status]}</strong><p>Revision {offer.revision} · {authoritativeFinancialSnapshot ? `${exactMoney(authoritativeFinancialSnapshot.snapshot.totals.net)} netto` : "Finanzprüfung offen"}</p><p>Nachfassen: {offer.followUpStatus}{offer.followUpAt ? ` · ${new Date(offer.followUpAt).toLocaleString("de-AT")}` : ""}</p>{offer.responseReference && <p className="break-words">Antwortbeleg: {offer.responseReference}</p>}</div>}
      {(!offer || editing) && <form className="space-y-3" onSubmit={event => { event.preventDefault(); save(); }}>
        {!offer && <><label className="block text-sm">Zugehöriger Lead<select className={field} value={leadId} required onChange={event => setLeadId(event.target.value)}><option value="">Lead auswählen</option>{leads.filter(lead => lead.contactId === deal.contactId && lead.projectId === deal.projectId).map(lead => <option key={lead.id} value={lead.id}>{lead.intent} · {lead.status}</option>)}</select></label>{!deal.organizationId && !contact?.organizationId && <label className="block text-sm">Unternehmen des Kunden<input className={field} value={companyName} required onChange={event => setCompanyName(event.target.value)} /></label>}</>}
        <label className="block text-sm">Betreff<input className={field} value={subject} required onChange={event => setSubject(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Empfängername<input className={field} value={recipientName} required onChange={event => setRecipientName(event.target.value)} /></label><label className="block text-sm">Empfänger-E-Mail<input className={field} type="email" value={recipientEmail} required onChange={event => setRecipientEmail(event.target.value)} /></label></div>
        <fieldset className="space-y-3"><legend className="text-sm font-semibold">Positionen · EUR netto</legend>{items.map((item, index) => <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4"><label className="text-sm sm:col-span-2">Leistung<input className={field} value={item.description} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, description: event.target.value } : line))} /></label><label className="text-sm">Anzahl<input className={field} type="number" min="1" step="1" value={item.quantity} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, quantity: event.target.value } : line))} /></label><label className="text-sm">Einzelpreis (€)<input className={field} inputMode="decimal" value={item.price} required onChange={event => setItems(current => current.map((line, n) => n === index ? { ...line, price: event.target.value } : line))} /></label>{items.length > 1 && <button className={button} type="button" onClick={() => setItems(current => current.filter((_, n) => n !== index))}>Position entfernen</button>}</div>)}<button className={button} type="button" disabled={items.length >= 100} onClick={() => setItems(current => [...current, { description: "", quantity: "1", price: "" }])}>Position ergänzen</button></fieldset>
        <label className="block text-sm">Leistungsumfang und Konditionen<textarea className={field} rows={4} value={terms} required onChange={event => setTerms(event.target.value)} /></label><label className="block text-sm">Gültig bis (lokale Zeit)<input className={field} type="datetime-local" value={validUntil} required onChange={event => setValidUntil(event.target.value)} /></label>
        <p className="text-sm">Wiederkehrende Leistungen mit allen verpflichtenden Perioden als Anzahl aufnehmen. Jede Änderung erfordert eine neue Freigabe.</p><button className={button} disabled={busy} type="submit">{offer ? "Neue Revision speichern" : "Angebotsentwurf anlegen"}</button>{editing && <button className={button} type="button" onClick={() => setEditing(false)}>Abbrechen</button>}
      </form>}
      {offer && !editing && <>
        <details className="rounded-lg bg-white p-3" open><summary className="min-h-11 cursor-pointer font-semibold">Exakte Fassung · Revision {offer.revision}</summary><article ref={articleRef} className="space-y-3 break-words"><h4 className="text-lg font-semibold">{offer.content.subject}</h4><p>An {offer.content.recipientName} · {offer.content.recipientEmail}</p><ul className="space-y-2">{offer.content.items.map((item, index) => { const component = authoritativeFinancialSnapshot?.snapshot.components.find(entry => entry.componentId === `line:${String(index + 1).padStart(3, "0")}`); return <li key={index}>{item.quantity} × {item.description}{component ? ` · Netto ${exactMoney(component.net)} · Steuer ${exactMoney(component.tax)} · Brutto ${exactMoney(component.gross)}` : ""}</li>; })}</ul>{authoritativeFinancialSnapshot ? <><p className="font-semibold">Nettosumme: {exactMoney(authoritativeFinancialSnapshot.snapshot.totals.net)}</p><p className="font-semibold">Steuer: {exactMoney(authoritativeFinancialSnapshot.snapshot.totals.tax)}</p><p className="font-semibold">Bruttosumme: {exactMoney(authoritativeFinancialSnapshot.snapshot.totals.gross)}</p><p role="note" className="rounded-lg bg-emerald-50 p-2 text-sm">Verifizierter unveränderlicher Finanzsnapshot · {authoritativeFinancialSnapshot.id} · Hash {authoritativeFinancialSnapshot.snapshotHash}</p></> : <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm">Finanzprüfung offen. Geld-, Steuer- und Rundungswerte werden nicht als autoritative Dokumentwerte ausgegeben.</p>}<p className="whitespace-pre-wrap">{offer.content.terms}</p><p>Gültig bis {new Date(offer.content.validUntil).toLocaleString("de-AT")}</p><p className="break-all text-xs">Inhaltsnachweis: {offer.contentDigest}</p></article></details>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !authoritativeFinancialSnapshot || !["APPROVED", "QUEUED", "SENT", "ACCEPTED", "REJECTED"].includes(offer.status)} onClick={printOffer}>{offer.status === "DRAFT" ? "Entwurf – Druck erst nach Freigabe" : !authoritativeFinancialSnapshot ? "Druck gesperrt – Finanzprüfung offen" : "Fassung drucken"}</button>{["DRAFT", "APPROVED", "SENT"].includes(offer.status) && <button className={button} disabled={busy} onClick={startRevision}>Neue Revision bearbeiten</button>}</div>
        {offer.status === "DRAFT" && <div className="space-y-2"><label className="block text-sm">Freigabe gültig bis (lokale Zeit)<input className={field} type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label><button className={button} disabled={busy || !view.canApprove} onClick={() => { const date = localDate(expiresAt); if (date) void run("approve", { ...scope, expiresAt: date }); }}>Diese Revision freigeben</button><p className="text-xs">Nur die konfigurierte Person mit höchstens 15 Minuten alter Anmeldung. Bei FRESH_AUTHENTICATION_REQUIRED erneut anmelden.</p></div>}
        {offer.status === "APPROVED" && <button className={button} disabled={busy} onClick={() => void run("queue_send", {})}>Manuellen Versand vorbereiten</button>}
        {["QUEUED", "SENT"].includes(offer.status) && <label className="block text-sm">{offer.status === "QUEUED" ? "Manueller Versandbeleg (z. B. Referenz des gesendeten E-Mails)" : "Kundenantwort / Annahme- oder Ablehnungsbeleg"}<input className={field} value={reference} onChange={event => setReference(event.target.value)} /></label>}
        {offer.status === "QUEUED" && <div className="space-y-2"><p className="text-sm">Die freigegebene Fassung selbst an den ausgewiesenen Empfänger senden. Erst danach den Versand belegen. Das CRM bestätigt keine Providerzustellung.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("record_sent", { ...scope, recipientEmail: offer.content.recipientEmail, reference, sentAt: new Date().toISOString() })}>Manuellen Versand bestätigen</button><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("record_unknown", { ...scope, recipientEmail: offer.content.recipientEmail, reference })}>Versandausgang unklar</button></div></div>}
        {(["APPROVED", "QUEUED"].includes(offer.status) || offer.status === "SENT") && <label className="block text-sm">Begründung / Gesprächsnotiz<textarea className={field} value={reason} onChange={event => setReason(event.target.value)} /></label>}
        {["APPROVED", "QUEUED"].includes(offer.status) && <button className={button} disabled={busy || !view.canApprove || !reason.trim()} onClick={() => void run("revoke", { reason })}>Freigabe widerrufen</button>}
        {offer.status === "SENT" && <div className="space-y-3"><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !reference.trim()} onClick={() => void run("accept", { ...scope, reference })}>Kundenannahme belegen</button><button className={button} disabled={busy || !reference.trim() || !reason.trim()} onClick={() => void run("reject", { ...scope, reference, reason })}>Kundenablehnung belegen</button></div><label className="block text-sm">Nächstes Nachfassen (lokale Zeit)<input className={field} type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} /></label><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || offer.followUpStatus === "SCHEDULED"} onClick={() => { const date = localDate(followUpAt); if (date) void run("schedule_follow_up", { dueAt: date }); }}>Nachfassaufgabe planen</button><button className={button} disabled={busy || offer.followUpStatus !== "SCHEDULED" || !reason.trim()} onClick={() => void run("stop_follow_up", { reason })}>Nachfassen stoppen</button><button className={button} disabled={busy || offer.followUpStatus !== "SCHEDULED" || !reason.trim()} onClick={() => void run("complete_follow_up", { reason })}>Nachfassen dokumentieren</button></div><p className="text-xs">Aufgabe für manuelle Kontaktaufnahme. Annahme und Ablehnung stoppen offene Nachfassaufgaben atomar.</p></div>}
        {view.deliveries.length > 0 && <ul className="space-y-1 text-xs">{view.deliveries.map(delivery => <li key={delivery.id} className="break-words">Revision {delivery.revision}: {delivery.status === "MANUALLY_ATTESTED" ? "Manuell belegt – Providerzustellung nicht geprüft" : delivery.status === "QUEUED" ? "Vorbereitet – nicht gesendet" : delivery.status}{delivery.receiptReference ? ` · ${delivery.receiptReference}` : ""}</li>)}</ul>}
      </>}
    </>}
  </section>;
}
