"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SellerListing } from "@/lib/crm-types";
import { createPropertyDraftStore, type PropertyDraft, type PropertyDraftStore } from "@/lib/property-draft-store";
import { createPropertyCoreDraft, propertyCoreDraftKey, savePropertyCoreDraft } from "@/lib/property-core-editing";
import { PROPERTY_AREA_MAX_SQM } from "@/lib/property-area-input";
import { csrfFetch } from "@/lib/security/csrf-client";
import { usePropertyDraft } from "@/lib/use-property-draft";
import { PropertyPurchaseCostsInput } from "./property-purchase-costs-input";
import { DEFAULT_PURCHASE_ANCILLARY_RATE } from "@/lib/property-purchase-costs";

export type PropertyCoreEditorProps = {
  listing: SellerListing;
  workspaceId: string;
  language: string;
  canEdit: boolean;
  draftStore?: PropertyDraftStore;
  draftUserId?: string;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
};

const inputClass = "mt-1 min-h-11 min-w-0 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-60";
const buttonClass = "min-h-11 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50";
const coreObjectTypes: readonly string[] = ["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"];
const coreRegions: readonly string[] = ["Wien", "Steiermark", "Tirol", "Salzburg", "Oberösterreich", "Niederösterreich", "Kärnten", "Burgenland", "Vorarlberg"];

export function PropertyCoreEditor(props: PropertyCoreEditorProps) {
  if (props.listing.workspaceId !== props.workspaceId || !/^[0-9a-f-]{36}$/i.test(props.listing.id)) {
    return <p role="alert">{props.language === "de" ? "Kein gespeichertes Objekt in diesem Workspace ausgewählt." : "No saved property selected in this workspace."}</p>;
  }
  return <PropertyCoreEditorForm key={`${props.workspaceId}:${props.listing.id}`} {...props} />;
}

function PropertyCoreEditorForm({ listing, workspaceId, language, canEdit, draftStore: suppliedStore, draftUserId = "current-user", onChanged, onClose }: PropertyCoreEditorProps) {
  const de = language === "de";
  const headingId = useId();
  const helpId = useId();
  const optionalNumberHelpId = useId();
  const unsupportedValueHelpId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [standaloneStore] = useState(createPropertyDraftStore);
  const store = suppliedStore ?? standaloneStore;
  const [initialDraft, setInitialDraft] = useState(() => createPropertyCoreDraft(listing));
  const scopeKey = propertyCoreDraftKey(draftUserId, workspaceId, listing.id);
  const { draft, setDraft, resetDraft, isDraftDirty, isMutationBusy } = usePropertyDraft(store, scopeKey, initialDraft);
  const [notice, setNotice] = useState<{ error: boolean; text: string; conflict?: boolean } | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const opener = document.activeElement;
    const section = sectionRef.current;
    headingRef.current?.focus();
    return () => {
      // Restore keyboard position only when focus was still in this editor.
      // A deliberate move elsewhere must not be undone on section changes.
      if (opener instanceof HTMLElement && opener.isConnected &&
          (document.activeElement === document.body || section?.contains(document.activeElement))) opener.focus();
    };
  }, []);
  useEffect(() => { if (notice?.error) noticeRef.current?.focus(); }, [notice]);
  const disabled = !canEdit || isMutationBusy;
  const objectTypeSupported = coreObjectTypes.includes(draft.objectType);
  const regionSupported = coreRegions.includes(draft.region);
  const hasUnsupportedValue = !objectTypeSupported || !regionSupported;
  const change = (key: keyof PropertyDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  // Shared sessions already install the global draft guard. The standalone
  // editor needs the same browser-exit protection without storing customer data.
  useEffect(() => {
    if (suppliedStore) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (!store.hasDrafts() && !store.isMutationBusy()) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [store, suppliedStore]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || hasUnsupportedValue || !isDraftDirty) return;
    setNotice(null);
    try {
      const result = await savePropertyCoreDraft({ draft, workspaceId, propertyId: listing.id, scopeKey, store, request: csrfFetch, onChanged });
      if (!mounted.current || result.kind === "busy") return;
      setInitialDraft(createPropertyCoreDraft(result.listing));
      setNotice({ error: false, text: result.kind === "saved_refresh_failed"
        ? (de ? "Änderungen sind gespeichert. Die Ansicht konnte nicht neu geladen werden. Bitte aktualisieren – nicht erneut speichern." : "Changes are saved, but the view could not refresh. Reload instead of saving again.")
        : (de ? "Stammdaten gespeichert. Veröffentlichung und Marktwert wurden nicht verändert." : "Core data saved. Publication and market valuation were not changed.") });
    } catch (error) {
      if (!mounted.current) return;
      const conflict = error instanceof Error && error.message === "property_core_conflict";
      const invalid = error instanceof Error && error.message.startsWith("Invalid property editor");
      setNotice({ error: true, conflict, text: conflict
        ? (de ? "Das Objekt wurde zwischenzeitlich geändert oder verschoben. Dein Entwurf bleibt erhalten. Vergleiche zuerst die aktuellen Daten; es wurde nichts überschrieben." : "This property changed or moved in the meantime. Your draft is retained. Review current data first; nothing was overwritten.")
        : invalid
          ? (de ? "Bitte Titel, Adresse, Region, Objekttyp und Zahlen prüfen. Fläche: höchstens zwei Dezimalstellen; Zimmer: höchstens eine. Dein Entwurf bleibt erhalten." : "Check the title, address, region, property type and numbers. Area supports two decimals; rooms one. Your draft is retained.")
          : (de ? "Speicherung nicht bestätigt. Dein Entwurf bleibt erhalten. Bei Verbindungsabbruch zuerst den aktuellen Stand prüfen, bevor du erneut speicherst." : "Saving was not confirmed. Your draft is retained. After a connection failure, check the current record before retrying.") });
    }
  }

  function discard() {
    if (isMutationBusy) return;
    if (isDraftDirty && !window.confirm(de ? "Änderungen an diesem Objekt wirklich verwerfen?" : "Discard changes to this property?")) return;
    resetDraft(); onClose();
  }

  async function discardAndRefresh() {
    if (isMutationBusy || !window.confirm(de ? "Entwurf verwerfen und aktuelle Daten laden? Kopiere benötigte Änderungen vorher." : "Discard the draft and load current data? Copy any changes you need first.")) return;
    try {
      await onChanged();
      resetDraft(); onClose();
    } catch {
      if (mounted.current) setNotice({ error: true, conflict: true, text: de ? "Aktuelle Daten konnten nicht geladen werden. Dein Entwurf bleibt erhalten." : "Could not load current data. Your draft is retained." });
    }
  }

  return <section ref={sectionRef} aria-labelledby={headingId} className="min-w-0 rounded-2xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h3 ref={headingRef} tabIndex={-1} id={headingId} className="text-xl font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4">{de ? "Stammdaten bearbeiten" : "Edit core data"}</h3>
        <p className="mt-1 break-words text-sm text-slate-600">{listing.title} · {de ? "Objekt-ID" : "Property ID"}: {listing.id}</p></div>
      <button type="button" className={buttonClass} disabled={isMutationBusy} onClick={onClose}>{de ? "Schließen – Entwurf behalten" : "Close – keep draft"}</button>
    </div>
    <p id={helpId} className="mt-3 text-sm text-slate-600">{de
      ? "Bearbeitet nur dieses gespeicherte Objekt. Projekt-/Einheitenzuordnung und Veröffentlichungsstatus bleiben unverändert. Eingaben bleiben beim Sektionswechsel im Arbeitsspeicher erhalten, nicht nach Neuladen oder Abmelden. Leere optionale Zahlen behalten den bisherigen Wert."
      : "Edits this saved property only. Project/unit links and publication status stay unchanged. Inputs remain in memory across section changes, not reload or sign-out. Blank optional numbers retain their existing value."}</p>
    {!canEdit ? <p role="status" className="mt-3 text-sm text-amber-800">{de ? "Für Änderungen fehlen die Immobilien-Schreibrechte." : "Property write permission is required."}</p> : null}
    {hasUnsupportedValue ? <p id={unsupportedValueHelpId} role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{de
      ? "Der vorhandene Objekttyp oder das Bundesland ist leer oder wird von diesem Editor nicht unterstützt. Der bisherige Wert bleibt unverändert. Wähle zum Speichern ausdrücklich einen unterstützten Wert aus; andernfalls kannst du schließen und den Entwurf behalten."
      : "The current property type or region is empty or not supported by this editor. The existing value is unchanged. Explicitly choose a supported value to save; otherwise close and keep your draft."}</p> : null}
    {notice ? <p ref={noticeRef} tabIndex={-1} aria-atomic="true" role={notice.error ? "alert" : "status"} className={`mt-3 rounded-xl p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${notice.error ? "bg-red-50 text-red-900" : "bg-emerald-50 text-emerald-900"}`}>{notice.text}</p> : null}
    {notice?.conflict ? <button type="button" className={`${buttonClass} mt-3`} disabled={isMutationBusy} onClick={() => void discardAndRefresh()}>{de ? "Entwurf verwerfen und neu laden" : "Discard draft and reload"}</button> : null}
    <form aria-labelledby={headingId} aria-describedby={helpId} onSubmit={(event) => void save(event)} className="mt-4" aria-busy={isMutationBusy}>
      <p className="mb-3 text-sm text-slate-600">{de ? "Mit * gekennzeichnete Felder sind Pflichtfelder." : "Fields marked * are required."}</p>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">{de ? "Objektstammdaten" : "Property core fields"}</legend>
        <label className="min-w-0 text-sm font-medium text-slate-700 sm:col-span-2">{de ? "Titel *" : "Title *"}<input className={inputClass} name="title" value={draft.title} onChange={(event) => change("title", event.target.value)} required maxLength={300} /></label>
        <label className="min-w-0 text-sm font-medium text-slate-700">{de ? "Objekttyp" : "Property type"}<select className={inputClass} name="objectType" aria-invalid={!objectTypeSupported || undefined} aria-describedby={!objectTypeSupported ? unsupportedValueHelpId : undefined} value={draft.objectType} onChange={(event) => change("objectType", event.target.value)}>{!objectTypeSupported ? <option disabled value={draft.objectType}>{draft.objectType || (de ? "Nicht angegeben" : "Not provided")} · {de ? "nicht unterstützt – bitte auswählen" : "unsupported – please choose"}</option> : null}{coreObjectTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="min-w-0 text-sm font-medium text-slate-700 sm:col-span-2">{de ? "Vollständige Adresse *" : "Full address *"}<input className={inputClass} name="address" value={draft.address} onChange={(event) => change("address", event.target.value)} required maxLength={1000} /></label>
        <label className="min-w-0 text-sm font-medium text-slate-700">{de ? "Bundesland" : "Region"}<select className={inputClass} name="region" aria-invalid={!regionSupported || undefined} aria-describedby={!regionSupported ? unsupportedValueHelpId : undefined} value={draft.region} onChange={(event) => change("region", event.target.value)}>{!regionSupported ? <option disabled value={draft.region}>{draft.region || (de ? "Nicht angegeben" : "Not provided")} · {de ? "nicht unterstützt – bitte auswählen" : "unsupported – please choose"}</option> : null}{coreRegions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Fläche (m²) *" : "Area (m²) *"}<input className={inputClass} name="areaSqm" type="number" min="0" max={PROPERTY_AREA_MAX_SQM} step="0.01" inputMode="decimal" required value={draft.areaSqm} onChange={(event) => change("areaSqm", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Zimmer (optional)" : "Rooms (optional)"}<input className={inputClass} name="rooms" type="number" min="0" max="999.9" step="0.1" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.rooms} onChange={(event) => change("rooms", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Baujahr (optional)" : "Year built (optional)"}<input className={inputClass} name="yearBuilt" type="number" min="1" max="9999" step="1" inputMode="numeric" aria-describedby={optionalNumberHelpId} value={draft.yearBuilt} onChange={(event) => change("yearBuilt", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Angebotspreis (EUR) *" : "Asking price (EUR) *"}<input className={inputClass} name="price" type="number" min="0" step="0.01" inputMode="decimal" required value={draft.price} onChange={(event) => change("price", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Öffentlicher Preis (EUR, optional)" : "Public price (EUR, optional)"}<input className={inputClass} name="publicPrice" type="number" min="0" step="0.01" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.publicPrice} onChange={(event) => change("publicPrice", event.target.value)} /></label>
      </fieldset>
      <PropertyPurchaseCostsInput language={language} price={draft.price} marketingType={draft.marketingType}
        mode={draft.purchaseAncillaryMode ?? "manual"} rate={draft.purchaseAncillaryRate ?? DEFAULT_PURCHASE_ANCILLARY_RATE}
        manualAmount={draft.purchaseAncillaryCosts} disabled={disabled}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
      <p id={optionalNumberHelpId} className="mt-3 text-sm text-slate-600">{de ? "Optionale Zahlen: leer lassen behält den gespeicherten Wert; es löscht ihn nicht." : "Optional numbers: leaving a field blank preserves its saved value; it does not clear it."}</p>
      <p role="status" aria-atomic="true" className="mt-3 text-sm text-slate-600">{isMutationBusy ? (de ? "Speichervorgang läuft …" : "Save in progress …") : isDraftDirty ? (de ? "Ungespeicherte Änderungen an diesem Objekt." : "Unsaved changes to this property.") : (de ? "Keine ungespeicherten Änderungen." : "No unsaved changes.")}</p>
      <div className="mt-4 flex flex-wrap gap-3"><button type="submit" disabled={disabled || hasUnsupportedValue || !isDraftDirty} aria-describedby={hasUnsupportedValue ? unsupportedValueHelpId : undefined} className="min-h-11 rounded-full bg-[var(--brand-primary,#f6d95d)] px-5 py-2 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{de ? "Änderungen speichern" : "Save changes"}</button>
        <button type="button" className={buttonClass} disabled={isMutationBusy || !isDraftDirty} onClick={discard}>{de ? "Entwurf verwerfen" : "Discard draft"}</button></div>
    </form>
  </section>;
}
