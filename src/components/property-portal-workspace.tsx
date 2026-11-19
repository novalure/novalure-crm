"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import { portalPropertyTypes, type PortalPropertyType, type PropertyPortalPreview, type PropertyPortalProfile } from "@/lib/property-portal";

type Draft = Omit<PropertyPortalProfile, "propertyType"> & { propertyType: PortalPropertyType | "" };
type State = { profiles: { id: string; profile: PropertyPortalProfile; revision: number }[]; jobs: { id: string; portal: string; status: string; createdAt: string; action: string }[]; canPrepare: boolean; schemaRelease: string; reference: string };
type Props = { workspaceId: string; propertyId: string; language: string };
const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm";
const buttonClass = "min-h-11 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50";
const empty = (id: string): Draft => ({ portalName: "", providerName: "", providerId: "", agencyId: "", externalObjectId: id, contactName: "", contactEmail: "", propertyType: "", includeAddress: false, includeMedia: true });
export function PropertyPortalWorkspace(props: Props) { return <PortalManager key={`${props.workspaceId}:${props.propertyId}`} {...props} />; }
function PortalManager({ workspaceId, propertyId, language }: Props) {
  const de = language === "de", endpoint = `/api/crm/property-portals?workspaceId=${encodeURIComponent(workspaceId)}&propertyId=${encodeURIComponent(propertyId)}`;
  const [state, setState] = useState<State | null>(null), [draft, setDraft] = useState<Draft>(() => empty(propertyId));
  const [dirty, setDirty] = useState(false), [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<PropertyPortalPreview | null>(null), [exportAction, setExportAction] = useState<"CHANGE" | "DELETE">("CHANGE"), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef<{ body: string; key: string; correlation: string } | null>(null), busyRef = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" }); const result = await response.json() as { data?: State; error?: string };
    if (!response.ok || !result.data) throw new Error(result.error || (de ? "Portalansicht nicht verfügbar" : "Portal view unavailable"));
    return result.data;
  }, [endpoint, de]);
  useEffect(() => { let alive = true; void load().then((data) => { if (alive) { setState(data); const first = data.profiles[0]; if (first) { setSelected(first.profile.portalName); setDraft(first.profile); } } }).catch((error: unknown) => { if (alive) setNotice(error instanceof Error ? error.message : "Ansicht nicht verfügbar"); }); return () => { alive = false; }; }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const savedProfile = state?.profiles.find((item) => item.profile.portalName === selected);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setDirty(true); setPreview(null); setReviewed(false); };
  async function command(action: string, extra: Record<string, unknown> = {}) {
    if (busyRef.current || (uncertain && !pending.current)) return;
    busyRef.current = true; setBusy(true); setNotice("");
    const attempt = pending.current ?? { body: JSON.stringify({ action, propertyId, ...extra }), key: crypto.randomUUID(), correlation: crypto.randomUUID() };
    pending.current = attempt;
    let confirmed = false;
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.key, "x-correlation-id": attempt.correlation }, body: attempt.body });
      const result = await response.json() as { data?: unknown; persisted?: boolean; preview?: boolean; error?: string };
      if (!response.ok) { if (response.status < 500) { pending.current = null; setUncertain(false); } throw new Error(result.error || (de ? "Vorgang nicht bestätigt" : "Action not confirmed")); }
      if (!result.data || (!result.persisted && !result.preview)) throw new Error(de ? "Ergebnis nicht bestätigt" : "Result not confirmed");
      confirmed = true;
      pending.current = null; setUncertain(false);
      const actualAction = (JSON.parse(attempt.body) as { action: string }).action;
      if (actualAction === "preview") { setPreview(result.data as PropertyPortalPreview); setReviewed(false); }
      else {
        const data = await load(); setState(data);
        if (actualAction === "save_profile") { const saved = result.data as { profile: PropertyPortalProfile }; setSelected(saved.profile.portalName); setDraft(saved.profile); setDirty(false); setPreview(null); }
        setNotice(de ? "Gespeichert. Es wurde nichts an ein Portal übertragen." : "Saved. Nothing was transferred to a portal.");
      }
    } catch (error) { if (pending.current) setUncertain(true); setNotice(confirmed ? (de ? "Gespeichert. Der Verlauf konnte nicht neu geladen werden. Bitte die Ansicht aktualisieren." : "Saved, but the history could not refresh. Please reload this view.") : error instanceof Error ? error.message : (de ? "Verbindung unterbrochen" : "Connection interrupted")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function download(jobId: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      const response = await fetch(`${endpoint}&jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/zip")) { const result = await response.json().catch(() => ({})) as { error?: string }; throw new Error(result.error || (de ? "Dateipaket nicht verfügbar" : "File package unavailable")); }
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
      link.href = url; link.download = `novalure-openimmo-${jobId}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(de ? "Download gestartet. Es wurde nichts an ein Portal übertragen." : "Download started. Nothing was transferred to a portal.");
    } catch (error) { setNotice(error instanceof Error ? error.message : (de ? "Download nicht bestätigt" : "Download not confirmed")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function save(event: FormEvent) { event.preventDefault(); const revision = state?.profiles.find((item) => item.profile.portalName === draft.portalName)?.revision ?? 0; void command("save_profile", { profile: draft, expectedRevision: revision }); }
  const disabled = busy || uncertain || !state?.canPrepare;
  const labels = de ? { apartment: "Wohnung", house: "Haus", land: "Grundstück", office: "Büro / Praxis", investment: "Renditeobjekt", other: "Sonstige" } : { apartment: "Apartment", house: "House", land: "Land", office: "Office / practice", investment: "Investment", other: "Other" };
  return <section className="mt-5 min-w-0 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5" aria-labelledby={`portal-heading-${propertyId}`}>
    <h3 id={`portal-heading-${propertyId}`} className="text-xl font-semibold text-slate-950">{de ? "Portalexport vorbereiten" : "Prepare portal export"}</h3>
    <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-950">{de ? "Es ist kein geprüfter Portaltransport verbunden. Hier bereitest du ein OpenImmo-Dateipaket zur manuellen Übergabe vor. Vorbereitung, Download und tatsächliche Veröffentlichung beim Empfänger sind getrennte Schritte." : "No verified portal transport is connected. Prepare an OpenImmo file package for manual delivery here. Preparation, download and actual publication by the recipient are separate steps."}</p>
    {notice ? <p role="status" className="mt-3 break-words text-sm text-slate-800">{notice}</p> : null}
    {uncertain ? <div className="mt-3 rounded-xl border border-amber-300 p-3"><p className="text-sm">{de ? "Das Ergebnis ist noch unklar. Prüfe den letzten Vorgang erneut mit derselben Vorgangskennung." : "The result is uncertain. Check the last action again using the same request reference."}</p><button type="button" className={`${buttonClass} mt-2`} disabled={busy} onClick={() => void command("retry")}>{de ? "Letzten Vorgang erneut prüfen" : "Recheck last action"}</button></div> : null}
    {!state ? <p className="mt-4 text-sm">{de ? "Portalprofile werden geladen …" : "Loading portal profiles …"}</p> : <>
      <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-sm font-medium">{de ? "Gespeichertes Empfängerprofil" : "Saved recipient profile"}<select className={inputClass} value={selected} disabled={disabled || dirty} onChange={(event) => { setSelected(event.target.value); setDraft(state.profiles.find((item) => item.profile.portalName === event.target.value)?.profile ?? empty(propertyId)); setPreview(null); setReviewed(false); }}><option value="">{de ? "Neues Profil" : "New profile"}</option>{state.profiles.map((item) => <option key={item.id} value={item.profile.portalName}>{item.profile.portalName}</option>)}</select></label>{dirty ? <button type="button" className={buttonClass} disabled={disabled} onClick={() => { setDraft(savedProfile?.profile ?? empty(propertyId)); setDirty(false); }}>{de ? "Profilentwurf verwerfen" : "Discard profile draft"}</button> : null}</div>
      <details className="mt-4" open={!selected || dirty}><summary className="min-h-11 cursor-pointer py-3 font-semibold">{de ? "Kennungen und Feldzuordnung" : "Identifiers and field mapping"}{dirty ? (de ? " · ungespeichert" : " · unsaved") : ""}</summary>
        <form onSubmit={save}><fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {([ ["portalName", de ? "Name des Empfängerprofils" : "Recipient profile name"], ["providerName", de ? "Öffentlicher Firmenname" : "Public agency name"], ["providerId", de ? "Anbieternummer beim Portal" : "Portal provider number"], ["agencyId", "OpenImmo Anbieter-ID"], ["externalObjectId", de ? "Stabile externe Objektkennung" : "Stable external property ID"], ["contactName", de ? "Öffentlicher Ansprechpartner" : "Public contact name"], ["contactEmail", de ? "Öffentliche Kontakt-E-Mail" : "Public contact email"] ] as const).map(([key, label]) => <label className="min-w-0 text-sm font-medium" key={key}>{label} *<input className={inputClass} name={`portal-${key}`} required type={key === "contactEmail" ? "email" : "text"} maxLength={key === "contactEmail" ? 254 : ["providerId", "agencyId", "externalObjectId"].includes(key) ? 128 : 200} value={draft[key]} onChange={(event) => change(key, event.target.value)} /></label>)}
          <label className="text-sm font-medium">{de ? "Objektart für den Empfänger" : "Recipient property type"} *<select className={inputClass} required value={draft.propertyType} onChange={(event) => change("propertyType", event.target.value as PortalPropertyType)}><option value="">{de ? "Bitte auswählen" : "Please choose"}</option>{portalPropertyTypes.map((type) => <option key={type} value={type}>{labels[type]}</option>)}</select></label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.includeAddress} onChange={(event) => change("includeAddress", event.target.checked)} />{de ? "Gespeicherte Straße und Hausnummer freigeben" : "Release saved street and house number"}</label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.includeMedia} onChange={(event) => change("includeMedia", event.target.checked)} />{de ? "Freigegebene Bilder und Grundrissbilder beilegen" : "Include approved images and floor plan images"}</label>
        </fieldset><p className="mt-3 text-sm text-stone-600">{de ? "Die Kennungen kommen aus deinem Vertrag mit dem Empfänger. Diese Felder verbinden kein Portal und nehmen keine Passwörter oder Zugangsschlüssel entgegen. Der freigegebene Preis stammt aus der gespeicherten Kanal-Preislogik." : "Get these identifiers from your agreement with the recipient. These fields do not connect a portal or accept passwords or access tokens. Released prices follow the property's saved channel price rules."}</p><button className={`${buttonClass} mt-3`} disabled={disabled} type="submit">{de ? "Profil speichern" : "Save profile"}</button></form>
      </details>
      <div className="mt-5 flex flex-wrap items-end gap-3"><label className="text-sm font-medium">{de ? "Exportaktion" : "Export action"}<select className={inputClass} value={exportAction} disabled={disabled} onChange={(event) => { setExportAction(event.target.value as "CHANGE" | "DELETE"); setPreview(null); setReviewed(false); }}><option value="CHANGE">{de ? "Anlegen / aktualisieren" : "Create / update"}</option><option value="DELETE">{de ? "Entfernung beim Empfänger vorbereiten" : "Prepare removal by recipient"}</option></select></label><button type="button" className={buttonClass} disabled={disabled || dirty || !selected} onClick={() => void command("preview", { portalName: selected, exportAction })}>{de ? "Gespeicherten Stand prüfen" : "Review saved data"}</button></div>
      {preview ? <div className="mt-4 rounded-xl border border-stone-200 p-4"><p className="font-semibold">OpenImmo {state.schemaRelease} · {preview.action} · {preview.profile.portalName}</p><ul className="mt-3 space-y-2 text-sm">{preview.checks.map((check) => <li key={check.id} className={check.status === "missing" ? "text-red-800" : check.status === "review" ? "text-amber-900" : "text-emerald-900"}>{check.status === "missing" ? "✕ " : check.status === "review" ? "○ " : "✓ "}{check.message}</li>)}</ul><details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 font-medium">{de ? "Inhalt der Exportdatei ansehen" : "View export file content"}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-stone-50 p-3 text-xs">{preview.xml}</pre></details><label className="mt-3 flex min-h-11 items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={reviewed} disabled={disabled} onChange={(event) => setReviewed(event.target.checked)} />{de ? "Ich habe Inhalt, Kennungen, Preis-/Adressfreigabe und offene Länder-/Empfängeranforderungen für dieses Dateipaket geprüft." : "I reviewed this package's content, identifiers, price/address release and outstanding country/recipient requirements."}</label><button type="button" className={`${buttonClass} mt-3`} disabled={disabled || !reviewed || preview.checks.some((check) => check.status === "missing")} onClick={() => void command("prepare", { portalName: selected, exportAction, expectedSourceFingerprint: preview.sourceFingerprint, reviewed })}>{de ? "Dateipaket erstellen" : "Create file package"}</button></div> : null}
      <h4 className="mt-6 font-semibold">{de ? "Exportverlauf" : "Export history"}</h4>{state.jobs.length ? <ul className="mt-3 space-y-3">{state.jobs.map((job) => <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 p-3"><div><p className="text-sm font-semibold">{job.portal} · {job.action}</p><p className="text-sm text-stone-600">{job.status === "prepared" ? (de ? "Dateipaket vorbereitet · nicht übertragen" : "Package prepared · not transferred") : job.status === "cancelled" ? (de ? "Verworfen" : "Cancelled") : job.status} · {job.createdAt.slice(0, 10)}</p></div>{job.status === "prepared" ? <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={buttonClass} onClick={() => void download(job.id)}>{de ? "ZIP herunterladen" : "Download ZIP"}</button><button type="button" disabled={disabled} className={buttonClass} onClick={() => void command("cancel", { jobId: job.id })}>{de ? "Paket verwerfen" : "Cancel package"}</button></div> : null}</li>)}</ul> : <p className="mt-2 text-sm text-stone-600">{de ? "Noch kein Dateipaket erstellt." : "No file package prepared yet."}</p>}
      <a className="mt-4 inline-flex min-h-11 items-center text-sm underline" href={state.reference} target="_blank" rel="noreferrer">{de ? "Offizielle OpenImmo-Datenbeschreibung" : "Official OpenImmo data specification"}</a>
    </>}
  </section>;
}
