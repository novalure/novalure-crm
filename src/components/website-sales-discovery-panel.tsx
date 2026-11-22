"use client";
import { useId, useRef, useState, type FormEvent, type ChangeEvent } from "react";
import { Button } from "./ui/button";
import { Field, Select, Textarea } from "./ui/field";
import { Surface } from "./ui/surface";
import { Notice, StatusChip } from "./ui/status";
import { discoveryPending, matchDiscovery, parseDiscoveryImport, registerDiscovery, retryDiscoveryOriginal, DiscoveryBrowserError } from "@/lib/website-sales-discovery-client";
import { websiteSalesDiscoveryContract, type WebsiteSalesDiscoveryCandidate, type WebsiteSalesDiscoveryMatch, type WebsiteSalesDiscoveryReceipt } from "@/lib/website-sales-discovery";

const copy = {
  de: { title: "Interessenten zuordnen", intro: "Recherchefunde importieren, Unternehmen und Standort prüfen und im vorhandenen Vertrieb weiterarbeiten.", input: "Rechercheergebnis (JSON)", import: "Funde prüfen", choose: "Interessent", match: "CRM-Zuordnung prüfen", company: "Unternehmen", newCompany: "Neues Unternehmen anlegen", location: "Standort", newLocation: "Neuen belegten Standort registrieren", contact: "Öffentlicher Geschäftskontakt", noContact: "Kontakt später klären", newContact: "Belegten Kontakt anlegen", reason: "Begründung der Zuordnung", review: "Ich habe Unternehmen, Standort und Quellen geprüft.", save: "Zuordnung übernehmen", notFound: "Die ursprüngliche Anfrage wurde im CRM nicht gefunden. Eine erneute Übermittlung ist eine separate Aktion.", retry: "Ursprüngliche Anfrage erneut übermitteln", pending: "Der Speicherstatus ist unklar. Die ursprüngliche Anfrage bleibt erhalten; bitte abgleichen.", reconcile: "Ursprüngliche Anfrage abgleichen", error: "Zuordnung nicht möglich. Quellen, Auswahl und aktuellen CRM-Stand prüfen.", saved: "Zuordnung gespeichert. Der bestehende Rechercheablauf ist geöffnet.", malformed: "Das Rechercheergebnis ist ungültig oder enthält keine belegten Firmen- und Standortdaten.", existing: "Vorhandene Anfragen werden erkannt. Die eindeutige Studio-Anfrage wird bei der Qualifizierung weiterverwendet.", source: "Quelle", status: { MATCH: "Passender Standort gefunden", AMBIGUOUS: "Zuordnung klären", NEW: "Neuer Datensatz erforderlich" } },
  en: { title: "Match prospects", intro: "Import research findings, review company and branch identity, then continue in the existing sales workflow.", input: "Research result (JSON)", import: "Review findings", choose: "Prospect", match: "Check CRM match", company: "Company", newCompany: "Create a new company", location: "Location", newLocation: "Register the evidenced new location", contact: "Public business contact", noContact: "Resolve contact later", newContact: "Create the evidenced contact", reason: "Matching rationale", review: "I have checked the company, location and sources.", save: "Confirm match", notFound: "The original request was not found in CRM. Submitting it again is a separate action.", retry: "Resubmit original request", pending: "The write outcome is unknown. The original request is retained; reconcile it before continuing.", reconcile: "Reconcile original request", error: "Cannot confirm the match. Check sources, selections and the current CRM records.", saved: "Match saved. The existing research workflow is open.", malformed: "The research result is invalid or lacks sourced company and location facts.", existing: "Existing enquiries are identified. A unique Studio enquiry is reused during qualification.", source: "Source", status: { MATCH: "Existing location found", AMBIGUOUS: "Identity review required", NEW: "New record required" } },
};
type Props = { workspaceId: string; actorId: string; projectId: string; language: string; blocked: boolean; canWrite: boolean;
  onOpen(data: WebsiteSalesDiscoveryReceipt): void; onPending(value: boolean): void };
export function WebsiteSalesDiscoveryPanel({ workspaceId, actorId, projectId, language, blocked, canWrite, onOpen, onPending }: Props) {
  const c = language === "de" ? copy.de : copy.en, id = useId().replace(/:/g, ""), errorRef = useRef<HTMLDivElement>(null);
  const draftKey = `novalure.website-discovery.draft.v1:${actorId}:${workspaceId}:${projectId}`;
  const [raw, setRaw] = useState(() => { try { return window.sessionStorage.getItem(draftKey) ?? ""; } catch { return ""; } });
  const [candidates, setCandidates] = useState<WebsiteSalesDiscoveryCandidate[]>([]), [selected, setSelected] = useState(0), [current, setCurrent] = useState<WebsiteSalesDiscoveryMatch | null>(null);
  const [companyId, setCompanyId] = useState(""), [locationId, setLocationId] = useState(""), [contactId, setContactId] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<"error" | "malformed" | "saved" | "notFound" | null>(null);
  const [pending, setPending] = useState(() => { try { return Boolean(discoveryPending(workspaceId, actorId)); } catch { return true; } });
  function notifyPending() { let value = true; try { value = Boolean(discoveryPending(workspaceId, actorId)); } catch { /* corrupt recovery fails closed */ } setPending(value); onPending(value); }
  function failure(value: "error" | "malformed") { setMessage(value); requestAnimationFrame(() => errorRef.current?.focus()); }
  async function check(candidate: WebsiteSalesDiscoveryCandidate) {
    setBusy(true); setMessage(null); setCurrent(null);
    try { const found = await matchDiscovery(workspaceId, projectId, candidate); setCurrent(found);
      const selectedCompany = found.identity?.companyId ?? (found.companies.length === 1 && found.companies[0]!.reasons.includes("EXACT_NORMALIZED_NAME") ? found.companies[0]!.companyId : "");
      setCompanyId(selectedCompany); setLocationId(found.identity?.locationId ?? ""); setContactId(found.contactId ?? (candidate.contacts.length === 1 && !found.contacts.length ? "NEW" : ""));
    } catch { failure("error"); } finally { setBusy(false); }
  }
  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || blocked || pending) return;
    try { const imported = parseDiscoveryImport(raw, { workspaceId, projectId }); window.sessionStorage.setItem(draftKey, raw); setCandidates(imported); setSelected(0); await check(imported[0]!); }
    catch { failure("malformed"); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; if (!file || busy || blocked || pending) return;
    if (file.size > 65536 || !file.name.toLowerCase().endsWith(".json")) { failure("malformed"); return; }
    try {
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const imported = parseDiscoveryImport(contents, { workspaceId, projectId });
      window.sessionStorage.setItem(draftKey, contents); setRaw(contents); setCandidates(imported); setSelected(0); await check(imported[0]!);
    } catch { failure("malformed"); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!current || !candidates[selected] || busy || blocked || pending || !canWrite) return;
    const form = event.currentTarget; if (!form.reportValidity()) return;
    const values = new FormData(form); setBusy(true); setMessage(null); onPending(true);
    try { const data = await registerDiscovery(workspaceId, actorId, { contractVersion: websiteSalesDiscoveryContract, operation: "register", projectId,
      candidate: candidates[selected]!, expectedMatchDigest: current.matchDigest, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      decision: { companyId: companyId || null, locationId: locationId || null, contactId: contactId && contactId !== "NEW" ? contactId : null,
        createCompany: !companyId, createContact: contactId === "NEW", reviewed: values.get("reviewed") === "on", reason: String(values.get("reason")).trim() } });
      setMessage("saved"); onOpen(data);
    } catch (error) { if (!(error instanceof DiscoveryBrowserError) || error.outcome !== "UNKNOWN") failure("error"); }
    finally { notifyPending(); setBusy(false); }
  }
  async function recover(retry = false) { setBusy(true); try { const data = await (retry ? retryDiscoveryOriginal(workspaceId, actorId) : registerDiscovery(workspaceId, actorId)); setMessage("saved"); onOpen(data); } catch (error) { if (error instanceof DiscoveryBrowserError && error.code === "DISCOVERY_NOT_FOUND") setMessage("notFound"); else failure("error"); } finally { notifyPending(); setBusy(false); } }
  return <Surface className="space-y-4" data-website-sales-discovery aria-labelledby={`${id}-title`}>
    <div><h3 id={`${id}-title`} className="text-lg font-semibold">{c.title}</h3><p className="mt-2 max-w-prose text-sm text-stone-600">{c.intro}</p></div>
    {message ? <div ref={errorRef} tabIndex={-1}><Notice tone={message === "saved" ? "success" : "danger"} announce={message === "saved" ? "polite" : "assertive"}>{c[message]}</Notice></div> : null}
    {pending ? <Notice tone="warning"><p>{c.pending}</p><Button className="mt-3 min-h-11" disabled={busy || blocked} onClick={() => void recover()}>{c.reconcile}</Button>{message === "notFound" ? <Button className="mt-3 min-h-11" disabled={busy || blocked} onClick={() => void recover(true)}>{c.retry}</Button> : null}</Notice> : null}
    <Field htmlFor={`${id}-file`} label={language === "de" ? "Rechercheergebnis importieren" : "Import research result"} hint={language === "de" ? "JSON-Datei aus der Recherche, bis 64 KB." : "Research JSON file, up to 64 KB."}>
      <input id={`${id}-file`} name="discoveryFile" type="file" accept=".json,application/json" className="min-h-11 max-w-full text-sm" disabled={busy || blocked || pending} onChange={event => void importFile(event)} />
    </Field>
    <details className="rounded-lg border border-stone-200 p-3"><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{language === "de" ? "Erweitert: Recherchetext einfügen" : "Advanced: paste research data"}</summary>
      <form onSubmit={event => void load(event)} className="space-y-3"><Field htmlFor={`${id}-json`} label={c.input}><Textarea id={`${id}-json`} name="discoveryImport" autoComplete="off" value={raw} maxLength={65536} rows={5} spellCheck={false} disabled={busy || blocked || pending} onChange={event => { setRaw(event.target.value); setCurrent(null); try { window.sessionStorage.setItem(draftKey,event.target.value); } catch { failure("error"); } }} /></Field><Button type="submit" disabled={busy || blocked || pending || !raw.trim()}>{c.import}</Button></form>
    </details>
    {candidates.length > 1 ? <Field htmlFor={`${id}-candidate`} label={c.choose}><Select id={`${id}-candidate`} name="discoveryCandidate" autoComplete="off" value={selected} disabled={busy || blocked || pending} onChange={event => { const index = Number(event.target.value); setSelected(index); void check(candidates[index]!); }}>{candidates.map((candidate, index) => <option key={candidate.candidateId} value={index}>{candidate.companyName} · {candidate.address}</option>)}</Select></Field> : null}
    {busy ? <p role="status">{c.match}…</p> : null}
    {current && candidates[selected] ? <form onSubmit={event => void save(event)} className="space-y-4"><StatusChip tone={current.status === "MATCH" ? "success" : "warning"}>{c.status[current.status]}</StatusChip>
      <p className="break-words font-semibold">{candidates[selected]!.companyName} · {candidates[selected]!.address}</p>
      <ul className="space-y-2 text-sm">{candidates[selected]!.sourceReferences.map(source => <li key={source.sourceId}><a className="text-blue-800 underline" href={source.sourceUrl} target="_blank" rel="noreferrer">{c.source}: {source.sourceId} · {new URL(source.sourceUrl).hostname}</a><blockquote className="mt-1 break-words text-stone-600">{source.quote}</blockquote></li>)}</ul>
      <fieldset disabled={busy || blocked || pending || !canWrite} className="space-y-4">
        <Field htmlFor={`${id}-company`} label={c.company}><Select id={`${id}-company`} name="discoveryCompany" autoComplete="off" value={companyId} onChange={event => { setCompanyId(event.target.value); setLocationId(""); setContactId(""); }}><option value="" disabled={current.companies.some(company => company.reasons.includes("EXACT_NORMALIZED_NAME"))}>{c.newCompany}</option>{current.companies.map(company => <option value={company.companyId} key={company.companyId}>{company.name}</option>)}</Select></Field>
        <Field htmlFor={`${id}-location`} label={c.location}><Select id={`${id}-location`} name="discoveryLocation" autoComplete="off" value={locationId} onChange={event => setLocationId(event.target.value)}><option value="">{c.newLocation}</option>{current.locations.filter(location => location.companyId === companyId).map(location => <option key={location.locationId} value={location.locationId}>{location.address}</option>)}</Select></Field>
        <Field htmlFor={`${id}-contact`} label={c.contact}><Select id={`${id}-contact`} name="discoveryContact" autoComplete="off" value={contactId} onChange={event => setContactId(event.target.value)}><option value="">{c.noContact}</option>{candidates[selected]!.contacts.length === 1 ? <option value="NEW">{c.newContact}: {candidates[selected]!.contacts[0]!.email}</option> : null}{current.contacts.filter(contact => contact.companyId === companyId || contact.companyId === null).map(contact => <option key={contact.contactId} value={contact.contactId}>{contact.name} · {contact.email}</option>)}</Select></Field>
        {current.existingLeads.length ? <Notice>{c.existing}</Notice> : null}
        <Field htmlFor={`${id}-reason`} label={c.reason} required><Textarea id={`${id}-reason`} name="reason" autoComplete="off" minLength={10} maxLength={1000} required rows={2} /></Field>
        <label className="flex min-h-11 items-start gap-3 text-sm"><input className="mt-1 size-5 shrink-0" type="checkbox" name="reviewed" required /><span>{c.review}</span></label>
        <Button type="submit" className="min-h-11">{c.save}</Button>
      </fieldset>
    </form> : null}
  </Surface>;
}
