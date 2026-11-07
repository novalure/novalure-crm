"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import type { WebExposeBrandAssetRecord, WebExposeTemplateConfiguration } from "@/lib/web-expose-templates";

type Props = { workspaceId: string; value: WebExposeTemplateConfiguration; disabled: boolean; onChange: (value: WebExposeTemplateConfiguration) => void };
type UploadAttempt = { key: string; correlation: string; file: File; purpose: "logo" | "letterhead" };
const inputClass = "mt-1 min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const buttonClass = "min-h-11 rounded-lg border border-stone-300 px-4 py-2 text-sm disabled:opacity-40";

export function WebExposeTemplateArtwork({ workspaceId, value, disabled, onChange }: Props) {
  const [assets, setAssets] = useState<WebExposeBrandAssetRecord[]>([]);
  const [purpose, setPurpose] = useState<"logo" | "letterhead">("logo");
  const [file, setFile] = useState<File | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<UploadAttempt | null>(null);
  const [message, setMessage] = useState("");
  const alive = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const endpoint = "/api/crm/expose-template-assets?workspaceId=" + encodeURIComponent(workspaceId);
  const locked = disabled || busy || pending !== null;
  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await csrfFetch(endpoint, { cache: "no-store", signal });
    const result = await response.json() as { assets?: WebExposeBrandAssetRecord[]; error?: string };
    if (!response.ok || !Array.isArray(result.assets)) throw new Error(result.error ?? "Firmenassets nicht verfügbar.");
    if (alive.current && !signal?.aborted) setAssets(result.assets);
    return result.assets;
  }, [endpoint]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void reload(controller.signal).catch(error => { if (alive.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Firmenassets nicht verfügbar."); });
    return () => { alive.current = false; controller.abort(); };
  }, [reload]);

  async function upload() {
    if (busy || disabled || (!pending && (!file || !reviewed))) return;
    const attempt = pending ?? { key: crypto.randomUUID(), correlation: crypto.randomUUID(), file: file!, purpose };
    setPending(attempt); setBusy(true); setMessage("");
    let resolved = false;
    try {
      const form = new FormData();
      form.set("file", attempt.file); form.set("purpose", attempt.purpose); form.set("reviewed", "true");
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "Idempotency-Key": attempt.key, "X-Correlation-Id": attempt.correlation }, body: form });
      const result = await response.json() as { data?: { id?: string }; error?: string };
      if (!response.ok) { if (response.status < 500) { resolved = true; if (alive.current) setPending(null); } throw new Error(result.error ?? "Firmenasset wurde nicht gespeichert."); }
      if (!result.data?.id) throw new Error("Speicherergebnis konnte nicht bestätigt werden.");
      resolved = true;
      if (!alive.current) return;
      setPending(null); onChange({ ...value, [attempt.purpose === "logo" ? "logoAssetId" : "letterheadAssetId"]: result.data.id });
      setFile(null); setReviewed(false); if (fileInput.current) fileInput.current.value = "";
      await reload();
      setMessage("Firmenasset freigegeben. Die Vorlage als neue Version speichern und am Objekt in der Vorschau prüfen.");
    } catch (error) {
      if (alive.current) setMessage(resolved ? error instanceof Error ? error.message : "Upload fehlgeschlagen." : "Ergebnis ungeklärt. Mit derselben Datei erneut prüfen.");
    } finally { if (alive.current) setBusy(false); }
  }

  async function revoke(asset: WebExposeBrandAssetRecord) {
    if (locked || !window.confirm("Freigabe auch für bestehende Exposélinks widerrufen?")) return;
    setBusy(true); setMessage("");
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Correlation-Id": crypto.randomUUID() }, body: JSON.stringify({ action: "revoke", id: asset.assetId, expectedRevision: asset.revision }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Freigabe nicht geändert.");
      await reload();
      if (alive.current) setMessage("Freigabe widerrufen. Dieses Asset wird auch an bestehenden Exposélinks nicht mehr ausgeliefert.");
    } catch (error) {
      if (alive.current) {
        try { const current = await reload(); setMessage(current.find(row => row.assetId === asset.assetId)?.approved === false ? "Freigabe ist widerrufen." : error instanceof Error ? error.message : "Freigabe prüfen."); }
        catch { setMessage("Das Ergebnis ist ungeklärt. Firmenassets neu laden und die Freigabe prüfen."); }
      }
    } finally { if (alive.current) setBusy(false); }
  }

  return <div className="space-y-4 rounded-xl border border-stone-200 p-4 sm:col-span-2">
    <h4 className="font-semibold">Logo, Briefpapier und Layout</h4>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Layout<select className={inputClass} disabled={locked} value={value.layout ?? "classic"} onChange={event => onChange({ ...value, layout: event.target.value as WebExposeTemplateConfiguration["layout"] })}><option value="classic">Klassisch</option><option value="editorial">Magazin</option><option value="compact">Kompakt</option></select></label>
      <label className="text-sm">Bilder pro Reihe<select className={inputClass} disabled={locked} value={value.imageGrid ?? 2} onChange={event => onChange({ ...value, imageGrid: Number(event.target.value) as 1 | 2 | 3 })}><option value={1}>1 - groß</option><option value={2}>2 - ausgewogen</option><option value={3}>3 - Übersicht</option></select></label>
      {(["logo", "letterhead"] as const).map(kind => {
        const key = kind === "logo" ? "logoAssetId" : "letterheadAssetId";
        return <label className="text-sm" key={kind}>{kind === "logo" ? "Firmenlogo" : "Briefpapier / Kopf- und Fußbereich"}<select className={inputClass} disabled={locked} value={value[key] ?? ""} onChange={event => { const next = { ...value }; if (event.target.value) next[key] = event.target.value; else delete next[key]; onChange(next); }}><option value="">Ohne</option>{assets.filter(asset => asset.purpose === kind && (asset.approved || asset.assetId === value[key])).map(asset => <option value={asset.assetId} key={asset.assetId} disabled={!asset.approved}>{asset.title}{asset.approved ? "" : " · Freigabe widerrufen"}</option>)}</select></label>;
      })}
    </div>
    <details>
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Neues Firmenasset hochladen und freigeben</summary>
      <p className="mt-2 text-xs leading-5 text-stone-600">PNG, JPG oder WebP bis 4 MB. Für Briefpapier eine A4-Grafik verwenden. Der Textbereich des PDFs bleibt deckend und lesbar; Kopf, Fuß und Außenränder zeigen das Briefpapier. Nur eigens hochgeladene Firmenbilder können ausgewählt werden.</p>
      <div className="mt-3 flex flex-wrap gap-3"><select aria-label="Art des Firmenassets" className={inputClass + " max-w-xs"} disabled={locked} value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)}><option value="logo">Logo</option><option value="letterhead">Briefpapier</option></select><input ref={fileInput} aria-label="Firmenbild auswählen" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => { setFile(event.target.files?.[0] ?? null); setReviewed(false); }} /></div>
      <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={locked} onChange={event => setReviewed(event.target.checked)} />Ich darf dieses Firmenbild veröffentlichen und habe es geprüft.</label>
      <button type="button" className={buttonClass + " mt-3"} disabled={disabled || busy || (!pending && (!file || !reviewed))} onClick={() => { void upload(); }}>{pending ? "Ergebnis erneut prüfen" : "Hochladen und freigeben"}</button>
    </details>
    {assets.some(asset => asset.approved) ? <details><summary className="min-h-11 cursor-pointer py-2 text-sm">Freigaben verwalten</summary>{assets.filter(asset => asset.approved).map(asset => <div key={asset.assetId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{asset.title}</span><button type="button" disabled={locked} className={buttonClass} onClick={() => { void revoke(asset); }}>Freigabe widerrufen</button></div>)}</details> : null}
    {message ? <p role="status" className="rounded-lg bg-stone-100 p-3 text-sm">{message}</p> : null}
  </div>;
}
