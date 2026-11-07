"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import { webExposeResourceMimeTypes, type WebExposeResource, type WebExposeResourceInput, type WebExposeResourceKind } from "@/lib/web-expose-media";

type Props = { workspaceId: string; propertyId: string; selectedIds: string[]; onSelectionChange: (ids: string[]) => void; language?: string };
type State = { resources: WebExposeResource[]; library: { assetId: string; title: string; mimeType: string; sizeBytes: number; kind: WebExposeResourceKind }[]; canEdit: boolean };
const input = "mt-1 min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm";
const button = "min-h-11 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50";
const labels = { de: { image: "Bild", floorplan: "Grundriss", document: "Dokument (PDF)", video: "Video", external_link: "Externer Link" }, en: { image: "Image", floorplan: "Floorplan", document: "Document (PDF)", video: "Video", external_link: "External link" } };
export function WebExposeMediaEditor(props: Props) { return <MediaEditor key={`${props.workspaceId}:${props.propertyId}`} {...props} />; }
function MediaEditor({ workspaceId, propertyId, selectedIds, onSelectionChange, language = "de" }: Props) {
  const de = language === "de", kindLabels = labels[de ? "de" : "en"];
  const endpoint = `/api/crm/web-expose-media?workspaceId=${encodeURIComponent(workspaceId)}&propertyId=${encodeURIComponent(propertyId)}`;
  const [state, setState] = useState<State | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [kind, setKind] = useState<Exclude<WebExposeResourceKind, "external_link">>("image"), [file, setFile] = useState<File | null>(null), [fileTitle, setFileTitle] = useState("");
  const [linkKind, setLinkKind] = useState<"video" | "external_link">("external_link"), [linkTitle, setLinkTitle] = useState(""), [linkUrl, setLinkUrl] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const pending = useRef<{ key: string; correlation: string; body: string | FormData } | null>(null), busyRef = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" }), result = await response.json() as { data?: State; error?: string };
    if (!response.ok || !result.data) throw new Error(result.error || (de ? "Medien konnten nicht geladen werden" : "Media could not be loaded"));
    return result.data;
  }, [endpoint, de]);
  useEffect(() => { let alive = true; void load().then((data) => { if (alive) setState(data); }).catch((error: unknown) => { if (alive) setNotice(error instanceof Error ? error.message : "Media unavailable"); }); return () => { alive = false; }; }, [load]);
  async function command(body?: Record<string, unknown> | FormData) {
    if (busyRef.current || (!pending.current && !body)) return;
    busyRef.current = true; setBusy(true); setNotice("");
    const attempt = pending.current ?? { key: crypto.randomUUID(), correlation: crypto.randomUUID(), body: body instanceof FormData ? body : JSON.stringify({ propertyId, ...body }) };
    pending.current = attempt; let confirmed = false;
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { ...(typeof attempt.body === "string" ? { "content-type": "application/json" } : {}), "idempotency-key": attempt.key, "x-correlation-id": attempt.correlation }, body: attempt.body });
      const result = await response.json() as { data?: WebExposeResource; persisted?: boolean; error?: string };
      if (!response.ok) { if (response.status < 500) { pending.current = null; setUncertain(false); } throw new Error(result.error || (de ? "Speicherung nicht bestätigt" : "Save not confirmed")); }
      if (!result.persisted || !result.data) throw new Error(de ? "Speicherung nicht bestätigt" : "Save not confirmed");
      confirmed = true; pending.current = null; setUncertain(false);
      setState(await load()); setNotice(de ? "Gespeichert. Die Auswahl wird mit dem Website-Entwurf gespeichert." : "Saved. The selection is saved with the website draft.");
      if (attempt.body instanceof FormData) { setFile(null); setFileTitle(""); }
    } catch (error) { if (pending.current) setUncertain(true); setNotice(confirmed ? (de ? "Gespeichert. Ansicht bitte erneut laden." : "Saved. Please reload the view.") : error instanceof Error ? error.message : "Save not confirmed"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function select(id: string) { onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]); }
  function move(id: string, offset: number) { const next = [...selectedIds], index = next.indexOf(id), target = index + offset; if (index < 0 || target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onSelectionChange(next); }
  const sorted = state ? [...state.resources].sort((a, b) => { const left = selectedIds.indexOf(a.id), right = selectedIds.indexOf(b.id); return left === -1 ? right === -1 ? a.position - b.position : 1 : right === -1 ? -1 : left - right; }) : [];
  return <section className="space-y-4 rounded-2xl border border-stone-200 bg-stone-50 p-4" aria-label={de ? "Website-Medien" : "Website media"}>
    <div><h3 className="font-semibold">{de ? "Bilder, Unterlagen und Videos" : "Images, documents and videos"}</h3><p className="mt-1 text-sm text-slate-600">{de ? "Dateien hochladen oder sichere Links ergänzen, Inhalt prüfen und freigeben. Nur ausdrücklich ausgewählte, freigegebene Ressourcen erscheinen nach Veröffentlichung auf der Website. Finanzierungsnachweise und interne Dokumente sind gesperrt." : "Upload files or add safe links, then review and approve them. Only selected, approved resources appear on the published website. Financial evidence and internal documents are protected."}</p><p className="mt-1 text-sm text-slate-600">{de ? "Direktupload: maximal 4 MB je Datei. Für größere Videos einen öffentlichen HTTPS-Videolink verwenden. Externe Inhalte öffnen sich erst nach einem Klick." : "Direct upload: up to 4 MB per file. Use a public HTTPS video link for larger videos. External content opens after a click."}</p></div>
    {notice ? <p role="status" className="rounded-xl bg-white p-3 text-sm">{notice}</p> : null}
    {uncertain ? <button className={button} disabled={busy} onClick={() => void command()}>{de ? "Gleichen Vorgang erneut prüfen" : "Retry the same action"}</button> : null}
    {!state ? <p className="text-sm">{de ? "Medien werden geladen …" : "Loading media …"}</p> : <>
      {state.canEdit ? <fieldset disabled={busy || uncertain} className="grid gap-4 rounded-xl border border-stone-200 bg-white p-3 lg:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">{de ? "Ergänzen" : "Add resources"}</legend>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (!file) return; if (file.size > 4194304 || !file.size) { setNotice(de ? "Maximal 4 MB pro Datei." : "Maximum 4 MB per file."); return; } const data = new FormData(); data.set("file", file); data.set("kind", kind); data.set("title", fileTitle.trim() || file.name); void command(data); }}>
          <label className="block text-sm">{de ? "Dateityp" : "File type"}<select className={input} value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setFile(null); }}>{(["image", "floorplan", "document", "video"] as const).map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></label>
          <label className="block text-sm">{de ? "Datei auswählen" : "Choose file"}<input key={kind} type="file" className={input} accept={webExposeResourceMimeTypes[kind].join(",")} onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) setFileTitle(selected.name); }} /></label>
          <label className="block text-sm">{de ? "Titel / Bildunterschrift" : "Title / caption"}<input className={input} maxLength={300} value={fileTitle} onChange={(event) => setFileTitle(event.target.value)} /></label>
          <button className={button} disabled={!file}>{de ? "Privat hochladen" : "Upload privately"}</button>
        </form>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void command({ action: "save", resource: { kind: linkKind, assetId: null, url: linkUrl, title: linkTitle, position: state.resources.length, visibility: "private", status: "draft" } }); }}>
          <label className="block text-sm">{de ? "Link-Typ" : "Link type"}<select className={input} value={linkKind} onChange={(event) => setLinkKind(event.target.value as typeof linkKind)}><option value="external_link">{kindLabels.external_link}</option><option value="video">{kindLabels.video}</option></select></label>
          <label className="block text-sm">{de ? "Titel" : "Title"}<input required className={input} maxLength={300} value={linkTitle} onChange={(event) => setLinkTitle(event.target.value)} /></label>
          <label className="block text-sm">HTTPS URL<input required type="url" className={input} maxLength={2048} placeholder="https://…" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} /></label>
          <button className={button}>{de ? "Link privat anlegen" : "Add private link"}</button>
        </form>
        {state.library.length ? <form className="space-y-2 lg:col-span-2" onSubmit={(event) => { event.preventDefault(); const item = state.library.find((entry) => entry.assetId === libraryId); if (item) void command({ action: "save", resource: { kind: item.kind, assetId: item.assetId, url: null, title: item.title, position: state.resources.length, visibility: "private", status: "draft" } }); }}><label className="block text-sm">{de ? "Aus den Marketingunterlagen dieses Objekts" : "From this property's marketing files"}<select className={input} value={libraryId} onChange={(event) => setLibraryId(event.target.value)}><option value="">{de ? "Datei auswählen" : "Choose file"}</option>{state.library.map((item) => <option key={`${item.assetId}:${item.kind}`} value={item.assetId}>{item.title} · {kindLabels[item.kind]}</option>)}</select></label><button className={button} disabled={!libraryId}>{de ? "Als private Ressource übernehmen" : "Add as private resource"}</button></form> : null}
      </fieldset> : null}
      <div className="space-y-3">{sorted.length ? sorted.map((resource) => <ResourceRow key={`${resource.id}:${resource.revision}`} resource={resource} de={de} label={kindLabels[resource.kind]} canEdit={state.canEdit} disabled={busy || uncertain} selected={selectedIds.includes(resource.id)} index={selectedIds.indexOf(resource.id)} selectedCount={selectedIds.length} preview={`${endpoint}&resourceId=${resource.id}&file=1`} onSelect={() => select(resource.id)} onMove={(offset) => move(resource.id, offset)} onSave={(value, reviewed) => command({ action: "save", resourceId: resource.id, expectedRevision: resource.revision, reviewed, resource: value })} onArchive={() => { onSelectionChange(selectedIds.filter((id) => id !== resource.id)); void command({ action: "archive", resourceId: resource.id, expectedRevision: resource.revision }); }} />) : <p className="text-sm text-slate-500">{de ? "Noch keine eigenen Website-Ressourcen. Bestehende Objektbilder lassen sich zusätzlich im Website-Entwurf auswählen." : "No website resources yet. Existing property images can also be included in the website draft."}</p>}</div>
    </>}
  </section>;
}
function ResourceRow({ resource, de, label, canEdit, disabled, selected, index, selectedCount, preview, onSelect, onMove, onSave, onArchive }: { resource: WebExposeResource; de: boolean; label: string; canEdit: boolean; disabled: boolean; selected: boolean; index: number; selectedCount: number; preview: string; onSelect: () => void; onMove: (offset: number) => void; onSave: (value: WebExposeResourceInput, reviewed: boolean) => Promise<void>; onArchive: () => void }) {
  const [title, setTitle] = useState(resource.title), [url, setUrl] = useState(resource.url ?? ""), [reviewed, setReviewed] = useState(false);
  const approved = resource.status === "approved" && resource.visibility === "published";
  const value = (approve: boolean): WebExposeResourceInput => ({ kind: resource.kind, assetId: resource.assetId, url: resource.url === null ? null : url, title, position: resource.position, visibility: approve ? "published" : "private", status: approve ? "approved" : "draft" });
  return <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-3">
    <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={disabled || !canEdit} checked={selected} onChange={onSelect} />{de ? "Für diese Website auswählen" : "Select for this website"}</label><span className="text-xs text-slate-600">{label} · {approved ? de ? "Freigegeben" : "Approved" : de ? "Privat / Entwurf" : "Private / draft"}</span>{selected ? <><button type="button" className={button} disabled={disabled || !canEdit || index <= 0} onClick={() => onMove(-1)} aria-label={de ? "Nach oben" : "Move up"}>↑</button><button type="button" className={button} disabled={disabled || !canEdit || index >= selectedCount - 1} onClick={() => onMove(1)} aria-label={de ? "Nach unten" : "Move down"}>↓</button></> : null}</div>
    <fieldset disabled={disabled || !canEdit} className="space-y-2"><label className="block text-sm">{de ? "Titel / Bildunterschrift" : "Title / caption"}<input className={input} value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></label>{resource.url !== null ? <label className="block text-sm">HTTPS URL<input type="url" className={input} value={url} onChange={(event) => { setUrl(event.target.value); setReviewed(false); }} /></label> : null}
      <div className="flex flex-wrap items-center gap-3"><a className="text-sm font-semibold underline" href={resource.url ?? preview} target="_blank" rel="noopener noreferrer">{de ? "Inhalt ansehen" : "View content"}</a><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />{de ? "Inhalt und Veröffentlichungsrechte geprüft" : "Content and publishing rights reviewed"}</label></div>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => void onSave(value(false), false)}>{approved ? de ? "Freigabe entziehen / privat speichern" : "Revoke / save privately" : de ? "Privat speichern" : "Save privately"}</button><button type="button" className={button} disabled={!reviewed} onClick={() => void onSave(value(true), reviewed)}>{de ? "Für Website freigeben" : "Approve for website"}</button><button type="button" className={button} onClick={onArchive}>{de ? "Aus Ressourcen entfernen" : "Remove resource"}</button></div>
    </fieldset>
  </div>;
}
