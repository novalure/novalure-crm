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
import { normalizePropertyGeography } from "@/lib/property-country";
import { PropertyGeographyFields } from "./property-geography-fields";
import { PropertyEnergyFields } from "./property-energy-fields";
import { PropertyDetailsEditor } from "./property-details-editor";
import { bindPropertyDetails,readPropertyDetails,type PropertyDetails } from "@/lib/property-details";

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

export function PropertyCoreEditor(props: PropertyCoreEditorProps) {
  if (props.listing.workspaceId !== props.workspaceId || !/^[0-9a-f-]{36}$/i.test(props.listing.id)) {
    return <p role="alert">{props.language === "de" ? "Kein gespeichertes Objekt in diesem Workspace ausgewählt." : "No saved property selected in this workspace."}</p>;
  }
  return <PropertyCoreEditorLoader key={`${props.workspaceId}:${props.listing.id}`} {...props}/>;
}

function PropertyCoreEditorLoader(props:PropertyCoreEditorProps){
 const [state,setState]=useState<{listing:SellerListing;details:PropertyDetails;snapshot:Record<string,unknown>}|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();void fetch(`/api/crm/properties?${new URLSearchParams({workspaceId:props.workspaceId,operation:"full",propertyId:props.listing.id})}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok||!value.data||value.data.listing.id!==props.listing.id||value.data.listing.workspaceId!==props.workspaceId)throw new Error("full_property_unavailable");setState(value.data);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return()=>controller.abort();},[props.workspaceId,props.listing.id,retry]);
 if(!state)return <section className="rounded-xl border border-slate-200 bg-white p-5" role="status"><p>{failed?(props.language==="de"?"Vollständige Objektdaten konnten nicht sicher geladen werden. Es werden keine leeren Detailwerte zum Speichern angeboten.":"Complete property data could not be loaded safely. No empty details are offered for saving."):(props.language==="de"?"Vollständige Objektdaten werden geladen …":"Loading complete property data …")}</p><div className="mt-3 flex gap-3">{failed?<button className={buttonClass} type="button" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>{props.language==="de"?"Erneut laden":"Retry"}</button>:null}<button className={buttonClass} type="button" onClick={props.onClose}>{props.language==="de"?"Schließen":"Close"}</button></div></section>;
 return <PropertyCoreEditorForm {...props} listing={state.listing} loadedDetails={state.details} loadedSnapshot={state.snapshot}/>;
}

function PropertyCoreEditorForm({ listing, workspaceId, language, canEdit, draftStore: suppliedStore, draftUserId = "current-user", onChanged, onClose,loadedDetails,loadedSnapshot }: PropertyCoreEditorProps&{loadedDetails:PropertyDetails;loadedSnapshot:Record<string,unknown>}) {
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
  const [initialDraft, setInitialDraft] = useState<PropertyDraft>(() => {const value=createPropertyCoreDraft(listing);return {...value,propertyDetails:loadedDetails,coreEdit:{...value.coreEdit!,expectedFullSnapshot:loadedSnapshot}};});
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
  const regionSupported = Boolean(normalizePropertyGeography(draft.geography));
  const hasUnsupportedValue = !objectTypeSupported || !regionSupported;
  const change = (key: keyof PropertyDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const extraFields: Array<[keyof PropertyDraft,string,string,string?]> = [
    ["objectNumber","Objektnummer","Property number"],["internalReference","Interne Referenz","Internal reference"],["postalCode",draft.geography?.countryCode==="IE"?"Eircode":"Postleitzahl",draft.geography?.countryCode==="IE"?"Eircode":"Postcode"],["city","Ort","City / locality"],["street","Straße (strukturiert)","Street (structured)"],["subObjectType","Unterobjektart","Property subtype"],
    ["availableFrom","Verfügbar ab","Available from","date"],["availableFromText","Verfügbarkeit – Freitext","Availability – free text"],["availabilityNote","Verfügbarkeit – Hinweis","Availability note"],["contactName","Ansprechpartner","Contact name"],["contactEmail","Kontakt-E-Mail","Contact email","email"],["contactPhone","Kontakt-Telefon","Contact phone","tel"],
    ["rentNet","Nettomiete EUR / Monat","Net monthly rent EUR","number"],["rentPrice","Bruttomiete EUR / Monat","Gross monthly rent EUR","number"],["monthlyCostsGross","Monatliche Gesamtkosten EUR","Gross monthly costs EUR","number"],
  ];

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
      <div className="min-w-0"><h3 ref={headingRef} tabIndex={-1} id={headingId} className="text-xl font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4">{de ? "Objekt vollständig bearbeiten" : "Edit complete property"}</h3>
        <p className="mt-1 break-words text-sm text-slate-600">{listing.title} · {de ? "Objekt-ID" : "Property ID"}: {listing.id}</p></div>
      <button type="button" className={buttonClass} disabled={isMutationBusy} onClick={onClose}>{de ? "Schließen – Entwurf behalten" : "Close – keep draft"}</button>
    </div>
    <p id={helpId} className="mt-3 text-sm text-slate-600">{de
      ? "Bearbeitet nur dieses gespeicherte Objekt. Projekt-/Einheitenzuordnung und Veröffentlichungsstatus bleiben unverändert. Eingaben bleiben beim Sektionswechsel im Arbeitsspeicher erhalten, nicht nach Neuladen oder Abmelden. Leere optionale Zahlen werden als unbekannt gespeichert."
      : "Edits this saved property only. Project/unit links and publication status stay unchanged. Inputs remain in memory across section changes, not reload or sign-out. Blank optional numbers are saved as unknown."}</p>
    {!canEdit ? <p role="status" className="mt-3 text-sm text-amber-800">{de ? "Für Änderungen fehlen die Immobilien-Schreibrechte." : "Property write permission is required."}</p> : null}
    {hasUnsupportedValue ? <p id={unsupportedValueHelpId} role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{de
      ? "Bitte einen unterstützten Objekttyp und das Objektland festlegen. Ein unbekanntes Land wird nicht aus der Adresse oder der Sprache geraten. Der Entwurf bleibt erhalten."
      : "Choose a supported property type and the property country. Unknown countries are never inferred from the address or viewer language. Your draft is retained."}</p> : null}
    {notice ? <p ref={noticeRef} tabIndex={-1} aria-atomic="true" role={notice.error ? "alert" : "status"} className={`mt-3 rounded-xl p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${notice.error ? "bg-red-50 text-red-900" : "bg-emerald-50 text-emerald-900"}`}>{notice.text}</p> : null}
    {notice?.conflict ? <button type="button" className={`${buttonClass} mt-3`} disabled={isMutationBusy} onClick={() => void discardAndRefresh()}>{de ? "Entwurf verwerfen und neu laden" : "Discard draft and reload"}</button> : null}
    <form aria-labelledby={headingId} aria-describedby={helpId} onSubmit={(event) => void save(event)} className="mt-4" aria-busy={isMutationBusy}>
      <p className="mb-3 text-sm text-slate-600">{de ? "Mit * gekennzeichnete Felder sind Pflichtfelder." : "Fields marked * are required."}</p>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">{de ? "Objektstammdaten" : "Property core fields"}</legend>
        <label className="min-w-0 text-sm font-medium text-slate-700 sm:col-span-2">{de ? "Titel *" : "Title *"}<input className={inputClass} name="title" value={draft.title} onChange={(event) => change("title", event.target.value)} required maxLength={300} /></label>
        <label className="min-w-0 text-sm font-medium text-slate-700">{de ? "Objekttyp" : "Property type"}<select className={inputClass} name="objectType" aria-invalid={!objectTypeSupported || undefined} aria-describedby={!objectTypeSupported ? unsupportedValueHelpId : undefined} value={draft.objectType} onChange={(event) => change("objectType", event.target.value)}>{!objectTypeSupported ? <option disabled value={draft.objectType}>{draft.objectType || (de ? "Nicht angegeben" : "Not provided")} · {de ? "nicht unterstützt – bitte auswählen" : "unsupported – please choose"}</option> : null}{coreObjectTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="min-w-0 text-sm font-medium text-slate-700 sm:col-span-2">{de ? "Vollständige Adresse *" : "Full address *"}<input className={inputClass} name="address" value={draft.address} onChange={(event) => change("address", event.target.value)} required maxLength={1000} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Fläche (m², optional)" : "Area (m², optional)"}<input className={inputClass} name="areaSqm" type="number" min="0" max={PROPERTY_AREA_MAX_SQM} step="0.01" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.areaSqm} onChange={(event) => change("areaSqm", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Zimmer (optional)" : "Rooms (optional)"}<input className={inputClass} name="rooms" type="number" min="0" max="999.9" step="0.1" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.rooms} onChange={(event) => change("rooms", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Baujahr (optional)" : "Year built (optional)"}<input className={inputClass} name="yearBuilt" type="number" min="1" max="9999" step="1" inputMode="numeric" aria-describedby={optionalNumberHelpId} value={draft.yearBuilt} onChange={(event) => change("yearBuilt", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Nutzung für Länderprüfung" : "Use for country review"}<select className={inputClass} name="usageType" value={draft.usageType} onChange={(event) => change("usageType", event.target.value)}><option value="">{de ? "Noch zu prüfen" : "Requires review"}</option><option value="residential">{de ? "Wohngebäude" : "Residential"}</option><option value="commercial">{de ? "Nichtwohngebäude" : "Non-residential"}</option><option value="mixed">{de ? "Gemischte Nutzung" : "Mixed use"}</option><option value="investment">{de ? "Investment · Gebäudenutzung prüfen" : "Investment · review building use"}</option></select></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Angebotspreis (EUR, optional)" : "Asking price (EUR, optional)"}<input className={inputClass} name="price" type="number" min="0" step="0.01" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.price} onChange={(event) => change("price", event.target.value)} /></label>
        <label className="text-sm font-medium text-slate-700">{de ? "Öffentlicher Preis (EUR, optional)" : "Public price (EUR, optional)"}<input className={inputClass} name="publicPrice" type="number" min="0" step="0.01" inputMode="decimal" aria-describedby={optionalNumberHelpId} value={draft.publicPrice} onChange={(event) => change("publicPrice", event.target.value)} /></label>
      </fieldset>
      <fieldset disabled={disabled} className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-3 font-semibold">{de?"Kennungen, Kontakt, Verfügbarkeit und Miete":"References, contact, availability and rent"}</legend>
        <label className="text-sm font-medium text-slate-700">{de?"Vermarktungsart":"Marketing type"}<select className={inputClass} value={draft.marketingType} onChange={e=>change("marketingType",e.target.value)}><option value="sale">{de?"Verkauf":"Sale"}</option><option value="rent">{de?"Vermietung":"Rent"}</option><option value="sale_or_rent">{de?"Verkauf oder Vermietung":"Sale or rent"}</option></select></label>
        {extraFields.map(([key,labelDE,labelEN,type])=><label key={key} className="min-w-0 text-sm font-medium text-slate-700">{de?labelDE:labelEN}<input className={inputClass} name={key} type={type??"text"} min={type==="number"?0:undefined} step={type==="number"?"0.01":undefined} maxLength={1000} value={typeof draft[key]==="string"?draft[key] as string:""} onChange={e=>change(key,e.target.value)}/></label>)}
        <label className="text-sm font-medium text-slate-700 sm:col-span-2 lg:col-span-3">{de?"Interne Notizen (privat)":"Internal notes (private)"}<textarea className={inputClass} rows={3} maxLength={10000} value={draft.internalNotes??""} onChange={e=>change("internalNotes",e.target.value)}/></label>
      </fieldset>
      <PropertyGeographyFields geography={draft.geography ?? null} region={draft.region} language={language} disabled={disabled}
        onChange={(geography) => setDraft((current) => ({ ...current, geography, region: geography.region,
          energyCertificate: current.geography?.countryCode !== geography.countryCode ? { version: 1, countryCode: geography.countryCode } : current.energyCertificate,
          ...(geography.countryCode !== "AT" ? { purchaseAncillaryMode: "manual" as const } : {}) }))} />
      <PropertyEnergyFields geography={draft.geography ?? null} energy={draft.energyCertificate ?? { version: 1, countryCode: draft.geography?.countryCode }} usageType={draft.usageType} yearBuilt={Number(draft.yearBuilt)} language={language} disabled={disabled}
        onChange={(energyCertificate) => setDraft((current) => ({ ...current, energyCertificate }))} />
      <PropertyPurchaseCostsInput language={language} price={draft.price} marketingType={draft.marketingType}
        countryCode={draft.geography?.countryCode ?? ""}
        mode={draft.purchaseAncillaryMode ?? "manual"} rate={draft.purchaseAncillaryRate ?? DEFAULT_PURCHASE_ANCILLARY_RATE}
        manualAmount={draft.purchaseAncillaryCosts} disabled={disabled}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
      <PropertyDetailsEditor details={bindPropertyDetails(draft.propertyDetails??readPropertyDetails(listing),draft as unknown as Record<string,unknown>)} language={language} countryCode={draft.geography?.countryCode} disabled={disabled}
        onChange={propertyDetails=>setDraft(current=>({...current,propertyDetails}))}/>
      <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">{de?"Die einzelnen Kostenpositionen mit Netto/USt/Brutto sowie alle fünf Textkanäle werden im Bereich Dokumente / Exposé desselben Objekts bearbeitet. Private Abgeber-, Kataster- und Notizangaben werden nicht automatisch veröffentlicht.":"Edit individual net/VAT/gross cost items and all five text channels in Documents / Exposé for this property. Private seller, cadastre and note details are never published automatically."}</p>
      <p id={optionalNumberHelpId} className="mt-3 text-sm text-slate-600">{de ? "Optionale Zahlen: Ein leeres Feld entfernt den gespeicherten Wert und setzt ihn auf unbekannt. Eine ausdrücklich eingegebene 0 bleibt 0." : "Optional numbers: an empty field clears the stored value to unknown. An explicitly entered 0 remains 0."}</p>
      <p role="status" aria-atomic="true" className="mt-3 text-sm text-slate-600">{isMutationBusy ? (de ? "Speichervorgang läuft …" : "Save in progress …") : isDraftDirty ? (de ? "Ungespeicherte Änderungen an diesem Objekt." : "Unsaved changes to this property.") : (de ? "Keine ungespeicherten Änderungen." : "No unsaved changes.")}</p>
      <div className="mt-4 flex flex-wrap gap-3"><button type="submit" disabled={disabled || hasUnsupportedValue || !isDraftDirty} aria-describedby={hasUnsupportedValue ? unsupportedValueHelpId : undefined} className="min-h-11 rounded-full bg-[var(--brand-primary,#f6d95d)] px-5 py-2 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{de ? "Änderungen speichern" : "Save changes"}</button>
        <button type="button" className={buttonClass} disabled={isMutationBusy || !isDraftDirty} onClick={discard}>{de ? "Entwurf verwerfen" : "Discard draft"}</button></div>
    </form>
  </section>;
}
