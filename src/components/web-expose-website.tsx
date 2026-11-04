"use client";
/* Images deliberately use the revocable same-origin capability endpoint. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, useSyncExternalStore, Fragment, type FormEvent, type ReactNode } from "react";
import { webExposeCopy, webExposeSections, type WebExposeSection, type WebExposePublic } from "@/lib/web-expose";
import { WebExposeResourceSections } from "@/components/web-expose-resource-sections";
import { PropertyBookingLinks } from "@/components/property-booking-links";
import { startExposeTracker } from "@/lib/web-expose-tracker";

const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
const memoryPreferences = new Map<string, string>();
function preference(key: string) {
  try { const raw = JSON.parse(localStorage.getItem(key) || "null"); return raw && Date.now() - raw.at < 180 * 86400000 && ["allowed", "rejected"].includes(raw.choice) ? raw.choice as string : "pending"; }
  catch { return memoryPreferences.get(key) || "pending"; }
}
function changePreference(key: string, choice: string) {
  memoryPreferences.set(key, choice);
  try { localStorage.setItem(key, JSON.stringify({ choice, at: Date.now() })); } catch { /* In-memory preference still permits an explicit choice. */ }
  subscribers.forEach(fn => fn());
}
function visitor() {
  const key = "novalure-expose-visitor-v1";
  try { const raw = JSON.parse(localStorage.getItem(key) || "null"); if (raw && Date.now() - raw.at < 30 * 86400000 && /^[A-Za-z0-9_-]{43}$/.test(raw.token)) return raw.token as string; } catch { /* Storage can be unavailable. */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { localStorage.setItem(key, JSON.stringify({ token, at: Date.now() })); } catch { /* No persistence is required for the current visit. */ }
  return token;
}
export function WebExposeWebsite({ data, token, preview = false, previewWorkspaceId, previewPropertyId }: { data: WebExposePublic; token?: string; preview?: boolean; previewWorkspaceId?: string; previewPropertyId?: string }) {
  const s = data.snapshot, copy = webExposeCopy[s.language];
  const key = `novalure-expose-consent-v1:${data.versionId}`;
  const choice = useSyncExternalStore(subscribe, () => preference(key), () => "pending");
  const withdraw = useRef<null | (() => void)>(null);
  const inquiryAttempt = useRef<{ key: string; body: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const mediaUrl = (assetId: string) => {
    if (preview && previewWorkspaceId) {
      const resource = s.resources?.find(r => r.assetId === assetId);
      if (resource && previewPropertyId) return `/api/crm/web-expose-media?workspaceId=${encodeURIComponent(previewWorkspaceId)}&propertyId=${encodeURIComponent(previewPropertyId)}&resourceId=${encodeURIComponent(resource.id)}&file=1`;
      return `/api/media/files/${encodeURIComponent(assetId)}?workspaceId=${encodeURIComponent(previewWorkspaceId)}`;
    }
    return token ? `/api/public/exposes/${encodeURIComponent(token)}/media/${encodeURIComponent(assetId)}` : "";
  };
  useEffect(() => {
    if (preview || !token || choice !== "allowed") return;
    let cancelled = false, cleanup: undefined | (() => void);
    void fetch(`/api/public/exposes/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", consent: true, visitorToken: visitor() }) }).then(r => r.json()).then((r: { sessionToken?: string }) => {
      if (!r.sessionToken) return;
      if (cancelled) { void fetch(`/api/public/exposes/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "withdraw", sessionToken: r.sessionToken }) }); return; }
      cleanup = startExposeTracker({ token, sessionToken: r.sessionToken, onWithdrawReady: fn => { withdraw.current = fn; } });
    }).catch(() => undefined);
    return () => { cancelled = true; cleanup?.(); withdraw.current = null; };
  }, [choice, preview, token]);
  function choose(value: "allowed" | "rejected") {
    if (value === "rejected") { withdraw.current?.(); withdraw.current = null; }
    changePreference(key, value); setShowSettings(false);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (preview || !token || busy || accepted) return;
    const fields = new FormData(e.currentTarget);
    const body = JSON.stringify({ action: "inquiry", website: fields.get("website"), inquiry: { name: fields.get("name"), email: fields.get("email"), phone: fields.get("phone"), message: fields.get("message"), unitId: selectedUnit || null, privacyRead: fields.get("privacy") === "on" } });
    const attempt = inquiryAttempt.current ?? { key: crypto.randomUUID().replaceAll("-", ""), body };
    inquiryAttempt.current = attempt; setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/public/exposes/${encodeURIComponent(token)}`, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key }, body: attempt.body });
      if (response.status >= 500) throw new Error("unknown");
      const result = await response.json() as { accepted?: boolean; reference?: string; error?: string };
      if (!response.ok) { inquiryAttempt.current = null; setUnknown(false); throw new Error(result.error || "rejected"); }
      if (!result.accepted || !result.reference) throw new Error("unknown");
      inquiryAttempt.current = null; setUnknown(false); setAccepted(true); setNotice(copy.sent);
    } catch { setUnknown(Boolean(inquiryAttempt.current)); setNotice(copy.failed); }
    finally { setBusy(false); }
  }
  const resources=s.resources||[];
  const images=[...s.media.filter(m=>m.kind==="image"),...resources.filter(r=>r.kind==="image"&&r.assetId).map(r=>({id:`resource:${r.id}`,title:r.title,kind:"image" as const,assetId:r.assetId!}))];
  const plans=[...s.media.filter(m=>m.kind==="floorplan").map(m=>({...m,mimeType:"image/jpeg"})),...resources.filter(r=>r.kind==="floorplan"&&r.assetId).map(r=>({id:`resource:${r.id}`,title:r.title,kind:"floorplan" as const,assetId:r.assetId!,mimeType:r.mimeType||"application/pdf"}))];
  const layout=s.template?.layout??"classic",grid=s.template?.imageGrid??2;
  const section = "mx-auto scroll-mt-24 px-5 sm:px-8 "+(layout==="compact"?"max-w-5xl py-8":layout==="editorial"?"max-w-6xl py-20":"max-w-6xl py-14");
  const sectionNodes: Record<WebExposeSection, ReactNode> = {
    hero: <section data-expose-section="hero" className="relative overflow-hidden bg-slate-950 text-white">
      {images[0] && (token || previewWorkspaceId) ? <img alt="" src={mediaUrl(images[0].assetId)} className="absolute inset-0 h-full w-full object-cover opacity-45" fetchPriority="high" /> : null}
      <div className="relative mx-auto max-w-6xl px-5 py-28 sm:px-8"><p className="mb-5 text-sm uppercase tracking-[0.2em]">{s.countryCode} · {s.location}</p><h1 className="max-w-3xl text-4xl font-medium leading-tight sm:text-6xl">{s.title}</h1>{s.priceVisibility!=="hide_price"?<p className="mt-7 text-2xl">{s.price || copy.priceRequest}</p>:null}<a href="#contact" data-expose-event="cta" data-expose-target="hero-inquiry" className="mt-8 inline-block rounded-full bg-white px-7 py-3 font-semibold text-slate-950">{copy.inquire}</a></div>
    </section>,
    facts: <section id="facts" data-expose-section="facts" className={section}><h2 className="mb-7 text-2xl font-semibold">{copy.facts}</h2><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{s.facts.map((f, i) => <div key={i} className="rounded-xl border border-stone-200 bg-white p-5"><dt className="text-sm text-stone-600">{f.label}</dt><dd className="mt-3 text-xl font-semibold">{f.value}</dd></div>)}</dl></section>,
    description: s.description ? <section id="description" data-expose-section="description" className={section}><h2 className="mb-6 text-2xl font-semibold">{copy.description}</h2><p className="max-w-3xl whitespace-pre-line text-lg leading-8 text-stone-700">{s.description}</p></section> : null,
    gallery: images.length ? <section id="gallery" data-expose-section="gallery" className={section}><h2 className="mb-6 text-2xl font-semibold">{copy.gallery}</h2><div className={"grid gap-5 "+(grid===3?"sm:grid-cols-2 lg:grid-cols-3":grid===2?"sm:grid-cols-2":"grid-cols-1")}>{images.map(m => <a key={m.id} href={mediaUrl(m.assetId) || undefined} target="_blank" rel="noreferrer" data-expose-event="gallery" data-expose-target={m.id} className="overflow-hidden rounded-xl bg-stone-200">{(token || previewWorkspaceId) ? <img src={mediaUrl(m.assetId)} alt={m.title} loading="lazy" className="aspect-[4/3] w-full object-cover transition-transform hover:scale-105" /> : <div className="p-6">{m.title}</div>}</a>)}</div></section> : null,
    floorplans: plans.length ? <section id="floorplans" data-expose-section="floorplans" className={section}><h2 className="mb-6 text-2xl font-semibold">{copy.floorplans}</h2><div className="grid gap-4 sm:grid-cols-2">{plans.map(m => <a className="rounded-xl border border-stone-200 bg-white p-5" key={m.id} href={mediaUrl(m.assetId) || undefined} target="_blank" rel="noreferrer" data-expose-event="floorplan" data-expose-target={m.id}>{(token || previewWorkspaceId) && m.mimeType.startsWith("image/") ? <img src={mediaUrl(m.assetId)} alt={m.title} loading="lazy" className="h-72 w-full object-contain" /> : <span className="mb-4 block rounded-lg bg-stone-100 px-4 py-12 text-center font-semibold">PDF ↗</span>}{m.title}</a>)}</div></section> : null,
    documents: <WebExposeResourceSections onlySection="documents" resources={resources} language={s.language} mediaUrl={mediaUrl} preview={preview} />,
    videos: <WebExposeResourceSections onlySection="videos" resources={resources} language={s.language} mediaUrl={mediaUrl} preview={preview} />,
    links: <WebExposeResourceSections onlySection="links" resources={resources} language={s.language} mediaUrl={mediaUrl} preview={preview} />,
    units: s.units.length ? <section id="units" data-expose-section="units" className={section}><h2 className="mb-6 text-2xl font-semibold">{copy.units}</h2>{s.inventoryAsOf ? <p className="mb-5 text-sm text-stone-600">{s.language === "de" ? "Verfügbarkeit und freigegebene Preise, Stand: " : s.language === "es" ? "Disponibilidad y precios autorizados: " : "Availability and approved prices as of: "}{new Date(s.inventoryAsOf).toLocaleString(s.locale)}</p> : null}<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{s.units.map(u => <article className="rounded-xl border border-stone-200 bg-white p-6" key={u.id}><h3 className="text-lg font-semibold">{u.number}</h3><p className="my-3 text-stone-600">{u.area} m² · {u.rooms} {copy.facts === "Eckdaten" ? "Zimmer" : s.language === "es" ? "habitaciones" : "rooms"}</p>{s.priceVisibility!=="hide_price"?<p className="font-semibold">{u.price || copy.priceRequest}</p>:null}<p className="my-3 text-sm">{u.status === "available" ? copy.available : u.status === "reserved" ? copy.reserved : u.status === "sold" ? copy.sold : u.status}</p>{u.status === "available" ? <a href="#contact" className="font-semibold text-blue-900" onClick={() => setSelectedUnit(u.id)} data-expose-event="unit" data-expose-target={u.id}>{copy.inquire} →</a> : null}</article>)}</div></section> : null,
    location: <section id="location" data-expose-section="location" className={section}><h2 className="mb-5 text-2xl font-semibold">{copy.location}</h2><p className="text-lg text-stone-700">{s.location}</p><a className="mt-4 inline-block font-semibold text-blue-900" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(s.location)}`} target="_blank" rel="noreferrer" data-expose-event="map" data-expose-target="open-map">{copy.location} ↗</a></section>,
    contact: <section id="contact" data-expose-section="contact" className="bg-white"><div className={section + " grid gap-12 md:grid-cols-2"}><div><h2 className="text-3xl font-semibold">{copy.contact}</h2><p className="mt-5 text-lg">{s.contact.name || s.controller}</p>{s.contact.email ? <a className="mt-3 block text-blue-900" href={`mailto:${s.contact.email}`} data-expose-event="cta" data-expose-target="email">{s.contact.email}</a> : null}{s.contact.phone ? <a className="mt-3 block text-blue-900" href={`tel:${s.contact.phone}`} data-expose-event="cta" data-expose-target="phone">{s.contact.phone}</a> : null}{!preview&&token?<div className="mt-6"><PropertyBookingLinks token={token} language={s.language}/></div>:null}</div>
      <form onSubmit={submit} data-expose-inquiry className="grid gap-4"><fieldset disabled={preview || busy || unknown || accepted} className="grid gap-4 disabled:opacity-70">
        <label className="grid gap-1 text-sm">{copy.name}<input required maxLength={200} autoComplete="name" name="name" className="rounded-lg border border-stone-300 p-3 text-base" /></label>
        <label className="grid gap-1 text-sm">{copy.email}<input required type="email" maxLength={254} autoComplete="email" name="email" className="rounded-lg border border-stone-300 p-3 text-base" /></label>
        <label className="grid gap-1 text-sm">{copy.phone}<input maxLength={80} type="tel" autoComplete="tel" name="phone" className="rounded-lg border border-stone-300 p-3 text-base" /></label>
        {s.units.length ? <label className="grid gap-1 text-sm">{copy.units}<select value={selectedUnit} onChange={e => setSelectedUnit(e.target.value)} className="rounded-lg border border-stone-300 p-3 text-base"><option value="">{copy.general}</option>{s.units.filter(u => u.status === "available").map(u => <option value={u.id} key={u.id}>{u.number}</option>)}</select></label> : null}
        <label className="grid gap-1 text-sm">{copy.message}<textarea name="message" maxLength={8000} rows={4} className="rounded-lg border border-stone-300 p-3 text-base" /></label>
        <label className="hidden" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <label className="flex items-start gap-3 text-sm leading-6"><input required type="checkbox" name="privacy" className="mt-1 h-5 w-5 shrink-0" /><span>{copy.agree} <a target="_blank" rel="noreferrer" className="underline" href={s.privacyUrl}>{copy.privacy}</a></span></label>
      </fieldset><button disabled={preview || busy || accepted} className="rounded-full bg-slate-950 px-7 py-3 font-semibold text-white disabled:opacity-50" type="submit">{busy ? "…" : unknown ? (s.language === "de" ? "Ergebnis erneut prüfen" : s.language === "es" ? "Comprobar resultado" : "Check result again") : copy.send}</button>{notice ? <p role={accepted ? "status" : "alert"} className={accepted ? "text-emerald-800" : "text-rose-800"}>{notice}</p> : null}</form>
    </div></section>
  };
  return <main lang={s.language} data-expose-layout={layout} className={"min-h-screen text-slate-900 "+(layout==="editorial"?"bg-white":"bg-[#f7f5f1]")}>
    {preview ? <div className="sticky top-0 z-30 bg-amber-100 p-3 text-center text-sm font-semibold text-amber-950">{s.language === "de" ? "Private Vorschau · keine Statistik · Anfragen deaktiviert" : s.language === "es" ? "Vista previa privada · sin estadísticas · consultas desactivadas" : "Private preview · no analytics · enquiries disabled"}</div> : null}
    <header style={{borderBottomWidth:4,borderBottomColor:s.template?.accentColor??"#0f172a"}} className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-8"><span className="flex items-center gap-4 font-semibold">{s.template?.logoAssetId&&<img src={mediaUrl(s.template.logoAssetId)} alt={s.template.companyName} className="h-10 max-w-36 object-contain"/>}{s.template?.companyName||s.controller}</span><nav className="flex flex-wrap items-center gap-5 text-sm"><a href="#facts">{copy.facts}</a>{images.length ? <a href="#gallery">{copy.gallery}</a> : null}{!preview && token ? <a href={`/api/public/exposes/${encodeURIComponent(token)}/pdf`} data-expose-event="pdf" data-expose-target="expose-pdf" className="rounded-full border border-stone-300 px-4 py-2 font-semibold">{s.language === "de" ? "Exposé als PDF" : s.language === "es" ? "Descargar PDF" : "Download PDF"} ↓</a> : null}<a className="font-semibold text-blue-900" href="#contact" data-expose-event="cta" data-expose-target="nav-inquiry">{copy.inquire}</a></nav></header>
    {s.template?.letterheadAssetId&&<div className="mx-auto max-w-6xl px-5 pt-5" aria-hidden="true"><img src={mediaUrl(s.template.letterheadAssetId)} alt="" className="max-h-32 w-full object-contain"/></div>}
    {(s.template?.sectionOrder??webExposeSections).map(sectionId=><Fragment key={sectionId}>{sectionNodes[sectionId]}</Fragment>)}
    <footer className="mx-auto flex max-w-6xl flex-wrap gap-6 px-5 py-8 text-sm text-stone-600"><span>© {s.controller}</span><a href={s.privacyUrl} rel="noreferrer" target="_blank">{copy.privacy}</a><a href={s.legalUrl} rel="noreferrer" target="_blank">{copy.legal}</a>{!preview ? <button onClick={() => setShowSettings(true)} type="button">{copy.preferences}</button> : null}</footer>
    {!preview && (choice === "pending" || showSettings) ? <aside aria-label={copy.preferences} className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-3xl rounded-2xl border border-stone-300 bg-white p-6 shadow-xl"><p className="text-sm leading-6 text-stone-700">{copy.consent}</p><a href={s.privacyUrl} rel="noreferrer" target="_blank" className="mt-2 inline-block text-sm underline">{copy.privacy}</a><div className="mt-4 flex flex-wrap gap-3"><button className="rounded-full border border-slate-900 px-5 py-3 text-sm font-semibold" type="button" onClick={() => choose("rejected")}>{choice === "allowed" ? copy.withdraw : copy.reject}</button><button className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white" type="button" onClick={() => choose("allowed")}>{copy.accept}</button></div></aside> : null}
  </main>;
}
