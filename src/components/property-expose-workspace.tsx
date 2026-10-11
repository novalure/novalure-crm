"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SellerListing } from "@/lib/crm-types";
import type { PropertyDraftStore } from "@/lib/property-draft-store";
import {
  PROPERTY_EXPOSE_MAX_FLOORPLANS, PROPERTY_EXPOSE_MAX_IMAGES, PROPERTY_EXPOSE_MAX_PDF_BYTES,
  type PropertyExposeMediaChoice, type PropertyExposeOptions, type PropertyExposeResponse,
  type PropertyExposeSource, type PropertyExposeState, type PropertyExposeVersion,
} from "@/lib/property-expose";
import { csrfFetch } from "@/lib/security/csrf-client";

const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-900 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} border-amber-300 bg-amber-100 hover:bg-amber-200`;
const inputClass = "min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-950 disabled:opacity-50";
const labelClass = "grid min-w-0 gap-2 text-sm font-semibold text-stone-800";
const panelClass = "min-w-0 rounded-lg border border-stone-200 bg-white p-4 sm:p-5";

type Props = {
  listing: SellerListing;
  workspaceId: string;
  language: string;
  draftStore: PropertyDraftStore;
  draftUserId: string;
};

/** Document links must stay on our authenticated API, including iframe navigation. */
function documentUrl(value: string | undefined) {
  if (!value?.startsWith("/api/") || /[\\\r\n]/.test(value)) return undefined;
  const parsed = new URL(value, "https://novalure.invalid");
  return parsed.origin === "https://novalure.invalid" && parsed.pathname.startsWith("/api/") ? value : undefined;
}

function confirmedState(payload: PropertyExposeResponse | null, propertyId: string) {
  const data = payload?.data;
  return payload?.persisted === true && data?.propertyId === propertyId && typeof data.revision === "string" && data.revision.length > 0 &&
    typeof data.canEdit === "boolean" && Array.isArray(data.versions) && Array.isArray(data.media) && Array.isArray(data.warnings) &&
    data.defaultOptions && Array.isArray(data.defaultOptions.imageIds) && Array.isArray(data.defaultOptions.floorPlanIds) ? data : null;
}

function versionDetails(version: PropertyExposeVersion, de: boolean) {
  const date = new Date(version.createdAt);
  return [version.versionLabel, version.source === "uploaded" ? (de ? "Eigenes PDF" : "Uploaded PDF") : "Novalure",
    Number.isNaN(date.getTime()) ? "" : date.toLocaleString(de ? "de-AT" : "en-GB"),
    `${version.pageCount} ${de ? "Seiten" : "pages"}`, `${(version.sizeBytes / 1024 / 1024).toFixed(1)} MB`].filter(Boolean).join(" · ");
}

function knownError(code: string | undefined, de: boolean) {
  const messages: Record<string, [string, string]> = {
    PDF_SIZE: ["Bitte ein PDF mit höchstens 10 MB auswählen.", "Select a PDF up to 10 MB."],
    PDF_INVALID: ["Das PDF ist beschädigt, zu komplex oder länger als 100 Seiten. Bitte erneut als einfaches PDF exportieren.", "The PDF is damaged, too complex or longer than 100 pages. Export it again as a simple PDF."],
    PDF_UNSAFE: ["Dieses PDF enthält Verschlüsselung, Formulare, Anhänge oder aktive Inhalte. Bitte eine ungeschützte PDF ohne diese Inhalte exportieren.", "This PDF contains encryption, forms, attachments or active content. Export an unprotected PDF without these features."],
    PDF_LIMIT: ["Die PDF-Prüfung konnte innerhalb der Verarbeitungsgrenzen nicht abgeschlossen werden. Bitte eine einfachere oder kleinere PDF auswählen.", "PDF verification exceeded processing limits. Select a simpler or smaller PDF."],
    PDF_VALIDATION_UNAVAILABLE: ["Die technische PDF-Prüfung ist gerade nicht verfügbar. Bitte später erneut versuchen.", "Technical PDF verification is currently unavailable. Please try again later."],
    COMPACT_OVERFLOW: ["Der Inhalt passt nicht in das kompakte Objektblatt. Beschreibung kürzen, weniger Bilder wählen oder zum ausführlichen Exposé wechseln.", "The content does not fit the compact sheet. Shorten the description, select fewer images or use the full brochure."],
    EXPOSE_TOO_LONG: ["Das Exposé ist zu lang. Bitte Beschreibung, Bilder oder Grundrisse reduzieren.", "The brochure is too long. Reduce the description, images or floor plans."],
    UNSUPPORTED_CHARACTERS: ["Der Text enthält Zeichen, die die PDF-Schrift nicht darstellen kann. Bitte Emojis oder besondere Schriftzeichen entfernen.", "The PDF font cannot display some characters. Remove emoji or unsupported script characters."],
    INVALID_IMAGE: ["Ein ausgewähltes Bild konnte nicht verarbeitet werden. Bitte Auswahl prüfen oder das Bild erneut hochladen.", "A selected image could not be processed. Check your selection or upload the image again."],
    INVALID_DOCUMENT: ["Ein ausgewählter Grundriss konnte nicht verarbeitet werden. Bitte Auswahl prüfen oder die Datei erneut hochladen.", "A selected floor plan could not be processed. Check your selection or upload the file again."],
    EXPOSE_FLOORPLAN_ADDRESS_REVIEW: ["Ein PDF-Grundriss kann die vollständige Adresse enthalten. Bitte die vollständige Adresse ausdrücklich erlauben oder den PDF-Grundriss abwählen und ein zuvor bereinigtes Grundrissbild verwenden.", "A PDF floor plan can contain the full address. Explicitly allow the full address, or deselect the PDF and use a previously redacted floor plan image."],
    EXPOSE_FLOORPLAN_LIMIT: ["Es können insgesamt höchstens acht Grundrissseiten aufgenommen werden. Bitte weniger oder kürzere Grundrisse auswählen.", "A maximum of eight floor plan pages can be included. Select fewer or shorter floor plans."],
    EXPOSE_OPTIONS_INVALID: ["Bitte Vorlage, sichtbare Angaben und Medienauswahl prüfen. Der Titel darf höchstens 180 Zeichen lang sein.", "Check the template, visible information and media selection. The title must be no longer than 180 characters."],
    EXPOSE_PRICE_MISSING: ["Der freigegebene Anzeigepreis fehlt. Bitte den Preis in den Stammdaten ergänzen oder die Preisanzeige für dieses PDF ausschalten.", "The approved display price is missing. Add it to the saved property data or turn off the price display for this PDF."],
    EXPOSE_MEDIA_BUDGET: ["Die ausgewählten Bilder und Grundrisse sind zusammen zu groß. Bitte weniger oder kleinere Dateien auswählen.", "The selected images and floor plans are too large in total. Select fewer or smaller files."],
    EXPOSE_CONFLICT: ["Die Immobilie oder das Exposé wurde zwischenzeitlich geändert. Aktuellen Stand neu laden und erneut prüfen.", "The property or brochure changed. Reload the current state and review it again."],
  };
  return code ? messages[code]?.[de ? 0 : 1] : undefined;
}

function warningText(code: string, de: boolean) {
  const messages: Record<string, [string, string]> = {
    EXPOSE_PRIVATE_ONLY: ["Das PDF wird privat am Objekt gespeichert. Es wird dadurch nicht öffentlich veröffentlicht.", "The PDF is stored privately with the property. This does not publish it publicly."],
    EXPOSE_COMPANY_PROFILE_NOT_APPROVED: ["Es liegt noch kein freigegebenes Firmenprofil vor. Unternehmensangaben können deshalb im PDF fehlen.", "No approved company profile is available yet. Company information may therefore be missing from the PDF."],
    EXPOSE_NO_ELIGIBLE_IMAGES: ["Es sind noch keine geeigneten gespeicherten Fotos oder Grundrisse verfügbar.", "No suitable saved photos or floor plans are available yet."],
    EXPOSE_ACTIVE_UNAVAILABLE: ["Die aktive Datei ist nicht verfügbar. Bitte eine verfügbare Version prüfen und ausdrücklich aktivieren.", "The active file is unavailable. Review an available version and explicitly activate it."],
  };
  return messages[code]?.[de ? 0 : 1] ?? (de ? "Bitte die Angaben und das fertige PDF vor der Freigabe sorgfältig prüfen." : "Review the information and final PDF carefully before approval.");
}

export function PropertyExposeWorkspace(props: Props) {
  if (props.listing.workspaceId !== props.workspaceId) {
    return <p role="alert">{props.language === "de" ? "Bitte ein gespeichertes Objekt in diesem Workspace auswählen." : "Select a saved property in this workspace."}</p>;
  }
  // A new property always owns a fresh request lifecycle and local form state.
  return <PropertyExposeForm key={`${props.workspaceId}:${props.listing.id}`} {...props} />;
}

function PropertyExposeForm({ listing, workspaceId, language, draftStore, draftUserId }: Props) {
  const de = language === "de";
  const endpoint = `/api/crm/properties/expose?${new URLSearchParams({ workspaceId, propertyId: listing.id })}`;
  const writeEndpoint = `/api/crm/properties/expose?${new URLSearchParams({ workspaceId })}`;
  const [data, setData] = useState<PropertyExposeState | null>(null);
  const [options, setOptions] = useState<PropertyExposeOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [removeRequested, setRemoveRequested] = useState(false);
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const focusPreview = useRef(false);
  const mutationBusy = useSyncExternalStore(draftStore.subscribe, draftStore.isMutationBusy, () => false);
  const hasPropertyDrafts = () => Boolean(
    draftStore.read(JSON.stringify(["property-core", draftUserId, workspaceId, listing.id])) ||
    draftStore.read(JSON.stringify(["property-text", draftUserId, workspaceId, listing.id]))
  );
  const hasUnsavedChanges = useSyncExternalStore(draftStore.subscribe, hasPropertyDrafts, () => false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const requests = controllers.current;
    requests.add(controller);
    const number = ++requestNumber.current;
    void csrfFetch(endpoint, { cache: "no-store", signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as PropertyExposeResponse | null;
        const next = confirmedState(payload, listing.id);
        if (!response.ok || !next) throw new Error("unconfirmed");
        if (!mounted.current || number !== requestNumber.current) return;
        setData(next); setOptions(next.defaultOptions);
        setPreviewId(next.activeDocumentId ?? next.versions.find((version) => version.available)?.id ?? null);
      }).catch(() => {
        if (mounted.current && number === requestNumber.current && !controller.signal.aborted) {
          setNotice({ error: true, text: de ? "Exposés konnten nicht geladen werden. Bitte erneut laden." : "Could not load brochures. Please reload." });
        }
      }).finally(() => {
        requests.delete(controller);
        if (mounted.current && number === requestNumber.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      requests.forEach((request) => request.abort()); requests.clear();
    };
  }, [endpoint, listing.id, de]);

  useEffect(() => {
    if (focusPreview.current) { previewHeading.current?.focus(); focusPreview.current = false; }
  }, [previewId]);

  async function reload() {
    if (busy || draftStore.isMutationBusy()) return;
    setLoading(true); setNotice(null); setReviewed(false); setRemoveRequested(false);
    const controller = new AbortController(); controllers.current.add(controller);
    const number = ++requestNumber.current;
    try {
      const response = await csrfFetch(endpoint, { cache: "no-store", signal: controller.signal, credentials: "same-origin" });
      const payload = await response.json().catch(() => null) as PropertyExposeResponse | null;
      const next = confirmedState(payload, listing.id);
      if (!response.ok || !next) throw new Error("unconfirmed");
      if (!mounted.current || number !== requestNumber.current) return;
      setData(next); setOptions(next.defaultOptions); setReloadRequired(false);
      setPreviewId(next.activeDocumentId ?? next.versions.find((version) => version.available)?.id ?? null);
      setNotice({ error: false, text: de ? "Gespeicherten Stand geladen." : "Saved state reloaded." });
    } catch {
      if (mounted.current && number === requestNumber.current && !controller.signal.aborted) {
        setReloadRequired(true);
        setNotice({ error: true, text: de ? "Der aktuelle Stand konnte nicht geladen werden. Bitte erneut versuchen." : "Could not reload the current state. Please try again." });
      }
    } finally {
      controllers.current.delete(controller);
      if (mounted.current && number === requestNumber.current) setLoading(false);
    }
  }

  async function mutate(operation: "generate" | "upload" | "activate" | "deactivate" | "preferences", extra: Record<string, unknown> = {}) {
    if (!data?.canEdit || loading || reloadRequired || busy || (operation === "generate" && hasPropertyDrafts())) return;
    const token = draftStore.acquireMutation();
    if (!token) return;
    const number = ++requestNumber.current;
    const controller = new AbortController(); controllers.current.add(controller);
    const revision = data.revision;
    setBusy(operation); setNotice(null);
    let status = 0;
    let failureCode: string | undefined;
    try {
      let body: string | FormData;
      if (operation === "upload") {
        if (!file || file.size > PROPERTY_EXPOSE_MAX_PDF_BYTES || !/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) throw new Error("invalid_file");
        body = new FormData(); body.append("operation", operation); body.append("propertyId", listing.id);
        body.append("expectedRevision", revision); body.append("file", file);
      } else {
        body = JSON.stringify({ operation, propertyId: listing.id, expectedRevision: revision,
          ...(operation === "preferences" ? {} : { confirmed: true }), ...extra });
      }
      const response = await csrfFetch(writeEndpoint, { method: "POST", body, signal: controller.signal,
        ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}) });
      status = response.status;
      const payload = await response.json().catch(() => null) as PropertyExposeResponse | null;
      failureCode = payload?.code;
      const next = confirmedState(payload, listing.id);
      if (!response.ok || !next || ((operation === "generate" || operation === "upload") &&
        (!payload?.documentId || !next.versions.some((version) => version.id === payload.documentId && version.available) || next.activeDocumentId !== data.activeDocumentId)) ||
        (operation === "activate" && next.activeDocumentId !== extra.documentId) ||
        (operation === "deactivate" && next.activeDocumentId !== null) ||
        (operation === "preferences" && (next.preferredSource !== extra.preferredSource || next.activeDocumentId !== data.activeDocumentId))) throw new Error("unconfirmed");
      if (!mounted.current || number !== requestNumber.current) return;
      setData(next); setReviewed(false); setRemoveRequested(false);
      if (payload?.documentId) {
        focusPreview.current = true; setPreviewId(payload.documentId);
      }
      if (operation === "upload") { setFile(null); setUploadInputKey((current) => current + 1); }
      setNotice({ error: false, text: operation === "generate" || operation === "upload"
        ? (de ? "PDF als Entwurf gespeichert. Vorschau prüfen und anschließend ausdrücklich aktivieren." : "PDF saved as a draft. Review the preview, then explicitly activate it.")
        : operation === "activate" ? (de ? "Aktives Exposé gespeichert." : "Active brochure saved.")
        : operation === "deactivate" ? (de ? "Aktive Auswahl entfernt. Die Versionen bleiben erhalten." : "Active selection removed. Versions are retained.")
        : (de ? "Bevorzugte Quelle gespeichert. Die aktive Datei bleibt unverändert." : "Preferred source saved. The active file is unchanged.") });
    } catch {
      if (!mounted.current || number !== requestNumber.current || controller.signal.aborted) return;
      setReloadRequired(status === 0 || status === 409 || status >= 500 || (status >= 200 && status < 300));
      const text = knownError(failureCode, de) ?? (status === 409
        ? (de ? "Die Immobilie oder das Exposé wurde zwischenzeitlich geändert. Aktuellen Stand neu laden und erneut prüfen." : "The property or brochure changed. Reload the current state and review it again.")
        : status === 403 ? (de ? "Du hast keine Berechtigung für diese Änderung. Bitte den aktuellen Stand neu laden." : "You do not have permission for this change. Please reload.")
        : status === 413 ? (de ? "Die Datei ist zu groß. Bitte ein PDF mit höchstens 10 MB wählen." : "The file is too large. Select a PDF up to 10 MB.")
        : status === 400 || status === 415 || status === 422 ? (de ? "Die Angaben oder das PDF konnten nicht verarbeitet werden. Auswahl prüfen; beschädigte oder geschützte PDFs bitte neu exportieren." : "The settings or PDF could not be processed. Check your selection; export damaged or protected PDFs again.")
        : (de ? "Speicherung nicht bestätigt. Bitte zuerst neu laden, bevor du den Vorgang wiederholst." : "Save was not confirmed. Reload before repeating the operation."));
      if (status === 403) setReloadRequired(true);
      setNotice({ error: true, text });
    } finally {
      controllers.current.delete(controller); draftStore.releaseMutation(token);
      if (mounted.current && number === requestNumber.current) setBusy(null);
    }
  }

  function selectPreview(id: string) {
    setReviewed(false); setRemoveRequested(false); setPreviewId(id);
  }

  function chooseFile(selected: File | undefined) {
    setFile(null); setNotice(null);
    if (!selected) return;
    if (!/\.pdf$/i.test(selected.name) || (selected.type && selected.type !== "application/pdf") || selected.size === 0 || selected.size > PROPERTY_EXPOSE_MAX_PDF_BYTES) {
      setUploadInputKey((current) => current + 1);
      setNotice({ error: true, text: de ? "Bitte eine PDF-Datei mit Inhalt und höchstens 10 MB auswählen." : "Choose a non-empty PDF file up to 10 MB." }); return;
    }
    setFile(selected);
  }

  const active = data?.versions.find((version) => version.id === data.activeDocumentId);
  const preview = data?.versions.find((version) => version.id === previewId);
  const activeDownload = active?.available ? documentUrl(active.downloadUrl) : undefined;
  const activePreview = active?.available ? documentUrl(active.previewUrl) : undefined;
  const previewUrl = preview?.available ? documentUrl(preview.previewUrl) : undefined;
  const locked = !data?.canEdit || loading || Boolean(busy) || mutationBusy || reloadRequired;
  const source = data?.preferredSource ?? "generated";

  return <section className={panelClass} aria-labelledby="property-expose-heading" aria-busy={loading || Boolean(busy)}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 id="property-expose-heading" className="text-xl font-semibold text-stone-950">{de ? "Exposé als PDF" : "Property brochure PDF"}</h4>
        <p className="mt-1 break-words text-sm text-stone-600">{data?.propertyTitle ?? listing.title}</p></div>
      <button className={buttonClass} type="button" disabled={loading || Boolean(busy) || mutationBusy} onClick={() => void reload()}>{de ? "Neu laden" : "Reload"}</button>
    </div>
    <div className="mt-3 text-sm" aria-live="polite" aria-atomic="true">
      {loading ? <p>{de ? "Exposés werden geladen …" : "Loading brochures …"}</p> : null}
      {busy ? <p>{busy === "generate" ? (de ? "PDF wird erstellt …" : "Creating PDF …") : busy === "upload" ? (de ? "PDF wird hochgeladen und geprüft …" : "Uploading and checking PDF …") : (de ? "Auswahl wird gespeichert …" : "Saving selection …")}</p> : null}
      {notice ? <p role={notice.error ? "alert" : "status"} className={`rounded-md border p-3 ${notice.error ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</p> : null}
    </div>
    {data && options ? <>
      {!data.canEdit ? <p className="mt-3 text-sm text-stone-600">{de ? "Du kannst vorhandene Exposés ansehen. Für Änderungen ist eine Bearbeitungsberechtigung erforderlich." : "You can view existing brochures. Editing permission is required for changes."}</p> : null}
      <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
        <h5 className="font-semibold">{de ? "Aktives Exposé" : "Active brochure"}</h5>
        {active ? <><p className="mt-2 break-words text-sm font-semibold">{active.fileName}</p><p className="mt-1 text-xs text-stone-600">{versionDetails(active, de)}</p></> : <p className="mt-2 text-sm">{de ? "Noch kein Exposé aktiv. Erstelle einen Entwurf oder lade dein eigenes PDF hoch." : "No active brochure yet. Create a draft or upload your own PDF."}</p>}
        {active?.stale ? <p className="mt-3 text-sm font-semibold text-amber-900">{de ? "Die Objektdaten haben sich seit dieser Version geändert. Bitte Inhalt prüfen und bei Bedarf eine neue Version erstellen oder hochladen. Die Datei wurde nicht verändert." : "Property data changed since this version. Review the content and create or upload a new version if needed. The file has not been changed."}</p> : null}
        {data.activeDocumentId && (!activeDownload || !activePreview) ? <p className="mt-2 text-sm text-rose-900" role="alert">{de ? "Die aktive Datei ist nicht verfügbar. Bitte eine verfügbare Version prüfen und auswählen." : "The active file is unavailable. Review and select an available version."}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {activePreview ? <a className={buttonClass} href={activePreview} target="_blank" rel="noopener noreferrer">{de ? "Exposé ansehen" : "View brochure"}</a> : null}
          {activeDownload ? <a className={primaryClass} href={activeDownload} download={active?.fileName}>{de ? "Exposé herunterladen" : "Download brochure"}</a> : null}
          {data.activeDocumentId && data.canEdit ? <button className={buttonClass} type="button" disabled={locked} onClick={() => setRemoveRequested(true)}>{de ? "Aktive Auswahl entfernen" : "Remove active selection"}</button> : null}
        </div>
        {removeRequested ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3" role="group" aria-label={de ? "Entfernen bestätigen" : "Confirm removal"}>
          <p className="text-sm">{de ? "Danach gibt es keinen aktiven Exposé-Download. Alle Versionen bleiben erhalten." : "There will be no active brochure download. All versions are retained."}</p>
          <div className="mt-2 flex flex-wrap gap-2"><button className={primaryClass} disabled={locked} type="button" onClick={() => void mutate("deactivate")}>{de ? "Auswahl jetzt entfernen" : "Remove selection now"}</button><button className={buttonClass} type="button" disabled={Boolean(busy)} onClick={() => setRemoveRequested(false)}>{de ? "Abbrechen" : "Cancel"}</button></div>
        </div> : null}
      </div>

      <fieldset className="mt-5" disabled={locked}>
        <legend className="font-semibold">{de ? "Quelle für den nächsten Entwurf" : "Source for the next draft"}</legend>
        <p className="mt-1 text-sm text-stone-600">{de ? "Die Quellenwahl wird für diese Immobilie gespeichert. Erst eine ausdrückliche Aktivierung ersetzt die aktive Datei." : "The source is saved for this property. The active file changes only when you explicitly activate a version."}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{(["generated", "uploaded"] as PropertyExposeSource[]).map((value) => <label key={value} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-md border p-3 ${source === value ? "border-amber-300 bg-amber-50" : "border-stone-200"}`}>
          <input type="radio" name={`expose-source-${listing.id}`} checked={source === value} onChange={() => void mutate("preferences", { preferredSource: value })} />
          <span className="text-sm font-semibold">{value === "generated" ? (de ? "Mit Novalure erstellen" : "Create with Novalure") : (de ? "Eigenes PDF hochladen" : "Upload your own PDF")}</span>
        </label>)}</div>
      </fieldset>

      {source === "generated" ? <div className="mt-5">
        {hasUnsavedChanges ? <p role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">{de ? "Für diese Immobilie gibt es ungespeicherte Texte oder Stammdaten. Bitte zuerst speichern und hier neu laden. Das PDF verwendet gespeicherte Angaben." : "This property has unsaved text or core data. Save it first, then reload here. PDFs use saved data."}</p> : null}
        <fieldset disabled={locked} className="grid gap-4"><legend className="mb-3 font-semibold">{de ? "Vorlage und sichtbare Angaben" : "Template and visible information"}</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className={labelClass}>{de ? "Vorlage" : "Template"}<select className={inputClass} value={options.template} onChange={(event) => setOptions({ ...options, template: event.target.value as PropertyExposeOptions["template"] })}><option value="compact">{de ? "Kompaktes Objektblatt" : "Compact property sheet"}</option><option value="full">{de ? "Ausführliches Exposé" : "Full brochure"}</option></select></label>
            <label className={labelClass}>{de ? "PDF-Sprache" : "PDF language"}<select className={inputClass} value={options.language} onChange={(event) => setOptions({ ...options, language: event.target.value as PropertyExposeOptions["language"] })}><option value="de">Deutsch</option><option value="en">English</option></select></label>
            <label className={labelClass}>{de ? "Adresse" : "Address"}<select className={inputClass} value={options.address} onChange={(event) => setOptions({ ...options, address: event.target.value as PropertyExposeOptions["address"] })}><option value="city">{de ? "Nur Ort" : "City only"}</option><option value="full">{de ? "Vollständige Adresse" : "Full address"}</option><option value="hidden">{de ? "Adresse ausblenden" : "Hide address"}</option></select></label>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2"><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={options.showPrice} onChange={(event) => setOptions({ ...options, showPrice: event.target.checked })} />{de ? "Freigegebenen Anzeigepreis zeigen" : "Show approved display price"}</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={options.showContact} onChange={(event) => setOptions({ ...options, showContact: event.target.checked })} />{de ? "Ansprechpartner zeigen" : "Show contact person"}</label></div>
          <label className={labelClass}>{de ? "Titel für dieses Exposé" : "Title for this brochure"}<input className={inputClass} maxLength={180} value={options.title ?? ""} placeholder={de ? "Gespeicherten Objekttitel verwenden" : "Use the saved property title"} onChange={(event) => setOptions({ ...options, title: event.target.value })} /></label>
          <label className={labelClass}>{de ? "Beschreibung für dieses Exposé" : "Description for this brochure"}<textarea className={inputClass} rows={5} maxLength={12000} value={options.description ?? ""} placeholder={de ? "Gespeicherten Exposétext verwenden" : "Use the saved brochure text"} onChange={(event) => setOptions({ ...options, description: event.target.value })} /></label>
          <p className="text-xs leading-5 text-stone-600">{de ? "Diese Eingaben gelten für den neuen PDF-Entwurf. Ausblenden schwärzt keine bereits in Texten oder Bildern enthaltenen Angaben. Prüfe Preis, Adresse und vertrauliche Inhalte in der fertigen PDF-Vorschau. Die Sprachauswahl übersetzt deine Texte nicht automatisch." : "These inputs apply to the new PDF draft. Hiding fields does not redact information already contained in text or images. Check price, address and confidential content in the final PDF preview. Selecting a language does not automatically translate your text."}</p>
          <MediaSelection media={data.media.filter((item) => item.kind === "image")} selected={options.imageIds} maximum={PROPERTY_EXPOSE_MAX_IMAGES} de={de} kind="image" disabled={locked} onChange={(imageIds) => setOptions({ ...options, imageIds })} />
          <MediaSelection media={data.media.filter((item) => item.kind === "floorplan")} selected={options.floorPlanIds} maximum={PROPERTY_EXPOSE_MAX_FLOORPLANS} de={de} kind="floorplan" disabled={locked} onChange={(floorPlanIds) => setOptions({ ...options, floorPlanIds })} />
        </fieldset>
        {data.warnings.length ? <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"><h5 className="font-semibold">{de ? "Hinweise zur Erstellung" : "Generation notes"}</h5><ul className="mt-2 list-disc space-y-1 pl-5">{data.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warningText(warning, de)}</li>)}</ul></div> : null}
        <button className={`${primaryClass} mt-4`} type="button" disabled={locked || hasUnsavedChanges} onClick={() => void mutate("generate", { options })}>{de ? "PDF-Entwurf erstellen" : "Create PDF draft"}</button>
      </div> : <div className="mt-5 rounded-lg border border-stone-200 p-4">
        <h5 className="font-semibold">{de ? "Eigenes Exposé" : "Your own brochure"}</h5>
        <p className="mt-2 text-sm leading-6 text-stone-600" id="expose-upload-help">{de ? "PDF, maximal 10 MB. Dein Dokument bleibt unverändert. Die Schalter für Preis, Adresse und Kontakt filtern ein hochgeladenes PDF nicht. Prüfe den gesamten Inhalt vor der Aktivierung." : "PDF, maximum 10 MB. Your document remains unchanged. Price, address and contact settings do not filter uploaded PDFs. Review the full content before activation."}</p>
        <label className={`${labelClass} mt-3`}>{de ? "PDF-Datei auswählen" : "Select PDF file"}<input key={uploadInputKey} className={`${inputClass} p-2`} type="file" accept="application/pdf,.pdf" aria-describedby="expose-upload-help" disabled={locked} onChange={(event) => chooseFile(event.target.files?.[0])} /></label>
        {file ? <p className="mt-2 break-words text-sm">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p> : null}
        <button type="button" className={`${primaryClass} mt-3`} disabled={locked || !file} onClick={() => void mutate("upload")}>{de ? "Als Entwurf hochladen" : "Upload as draft"}</button>
      </div>}

      <div className="mt-6 border-t border-stone-200 pt-5">
        <h5 className="font-semibold">{de ? "Gespeicherte Versionen" : "Saved versions"}</h5>
        {data.versions.length ? <><label className={`${labelClass} mt-3`}>{de ? "Version für die Vorschau" : "Version to preview"}<select className={inputClass} value={previewId ?? ""} disabled={loading || Boolean(busy)} onChange={(event) => selectPreview(event.target.value)}><option value="" disabled>{de ? "Version auswählen" : "Select a version"}</option>{data.versions.map((version) => <option key={version.id} value={version.id}>{version.id === data.activeDocumentId ? (de ? "Aktiv · " : "Active · ") : (de ? "Entwurf / ältere Version · " : "Draft / earlier version · ")}{versionDetails(version, de)}{version.stale ? (de ? " · älterer Objektstand" : " · older property data") : ""}{!version.available ? (de ? " · nicht verfügbar" : " · unavailable") : ""}</option>)}</select></label>
          {preview ? <div className="mt-4"><h5 ref={previewHeading} tabIndex={-1} className="font-semibold">{de ? "PDF-Vorschau" : "PDF preview"}</h5><p className="mt-2 break-words text-sm">{preview.fileName}</p><p className="mt-1 text-xs text-stone-600">{versionDetails(preview, de)}</p>
            {preview.stale ? <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">{de ? "Diese Datei gehört zu einem älteren Objektstand. Vergleiche insbesondere Preis, Texte und Bilder mit den aktuellen Angaben." : "This file belongs to an older property state. Compare its price, text and images with the current information."}</p> : null}
            {previewUrl ? <><iframe key={`${preview.id}:${previewUrl}`} title={`${de ? "PDF-Vorschau" : "PDF preview"}: ${preview.fileName}`} src={`${previewUrl}#view=FitH&navpanes=0`} className="mt-3 h-[480px] w-full min-w-0 rounded-md border border-stone-300 bg-stone-50 sm:h-[640px]" />
              <p className="mt-2 text-sm text-stone-600">{de ? "Falls dein Browser die PDF-Vorschau nicht anzeigt, öffne die Datei in einem neuen Tab." : "If your browser cannot display the PDF preview, open the file in a new tab."}</p>
              <a className={`${buttonClass} mt-2`} href={previewUrl} target="_blank" rel="noopener noreferrer">{de ? "PDF in neuem Tab öffnen" : "Open PDF in new tab"}</a>
              {preview.id !== data.activeDocumentId ? <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
                {preview.source === "uploaded" ? <p className="mb-3 text-sm font-semibold">{de ? "Eigenes PDF: Preis, Adresse und vertrauliche Inhalte werden nicht automatisch ausgeblendet oder korrigiert." : "Uploaded PDF: price, address and confidential content are not automatically hidden or corrected."}</p> : null}
                <label className="flex min-h-11 items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={reviewed} disabled={locked} onChange={(event) => setReviewed(event.target.checked)} /><span>{de ? "Ich habe diese PDF-Vorschau einschließlich Preis, Adresse und vertraulicher Angaben geprüft und gebe diese Datei als aktives Exposé frei." : "I have reviewed this PDF, including its price, address and confidential information, and approve this file as the active brochure."}</span></label>
                <button className={`${primaryClass} mt-3`} disabled={locked || !reviewed || !documentUrl(preview.downloadUrl)} type="button" onClick={() => { if (reviewed) void mutate("activate", { documentId: preview.id }); }}>{de ? "Als aktives Exposé verwenden" : "Use as active brochure"}</button>
              </div> : <p className="mt-3 text-sm font-semibold text-emerald-900">{de ? "Diese Version ist das aktive Exposé." : "This version is the active brochure."}</p>}
            </> : <p className="mt-3 text-sm text-rose-900" role="alert">{de ? "Für diese Version ist keine sichere PDF-Vorschau verfügbar." : "A safe PDF preview is not available for this version."}</p>}
          </div> : null}</> : <p className="mt-2 text-sm text-stone-600">{de ? "Noch keine Version gespeichert." : "No versions saved yet."}</p>}
      </div>
    </> : null}
  </section>;
}

function MediaSelection({ media, selected, maximum, de, kind, disabled, onChange }: {
  media: PropertyExposeMediaChoice[]; selected: string[]; maximum: number; de: boolean;
  kind: "image" | "floorplan"; disabled: boolean; onChange: (ids: string[]) => void;
}) {
  const ordered = [...selected.map((id) => media.find((item) => item.id === id)).filter((item): item is PropertyExposeMediaChoice => Boolean(item)),
    ...media.filter((item) => !selected.includes(item.id))];
  function move(index: number, direction: number) {
    const target = index + direction;
    if (disabled || index < 0 || target < 0 || target >= selected.length) return;
    const next = [...selected]; [next[index], next[target]] = [next[target], next[index]]; onChange(next);
  }
  return <fieldset className="min-w-0" disabled={disabled}><legend className="font-semibold">{kind === "image" ? (de ? "Fotos und Reihenfolge" : "Photos and order") : (de ? "Grundrisse und Reihenfolge" : "Floor plans and order")} · {selected.length}/{maximum}</legend>
    <p className="mt-1 text-xs leading-5 text-stone-600">{kind === "image" ? (de ? "Das erste ausgewählte Foto ist das Titelbild. Mit den Pfeilen bestimmst du die Reihenfolge." : "The first selected photo is the cover image. Use the arrows to set the order.") : (de ? "Grundrisse werden vollständig dargestellt. Du kannst geeignete gespeicherte Medien auswählen." : "Floor plans are shown in full. You can select suitable saved media.")}</p>
    {kind === "floorplan" && media.some((item) => item.mimeType === "application/pdf") ? <p className="mt-2 text-sm text-amber-900">{de ? "PDF-Grundrisse können eine Adresse enthalten und erfordern die Einstellung „Vollständige Adresse“. Alternativ ein zuvor bereinigtes Grundrissbild verwenden. Insgesamt sind höchstens acht Grundrissseiten möglich." : "PDF floor plans may contain an address and require the Full address setting. Alternatively, use a previously redacted floor plan image. A maximum of eight floor plan pages is supported."}</p> : null}
    {!ordered.length ? <p className="mt-2 text-sm text-stone-600">{de ? "Keine geeigneten gespeicherten Medien verfügbar." : "No suitable saved media available."}</p> : <ul className="mt-3 grid gap-3 sm:grid-cols-2">{ordered.map((item) => {
      const index = selected.indexOf(item.id);
      return <li key={item.id} className={`min-w-0 rounded-md border p-3 ${index >= 0 ? "border-amber-300 bg-amber-50" : "border-stone-200"}`}>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={index >= 0} disabled={disabled || (index < 0 && selected.length >= maximum)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span className="break-words font-semibold">{index >= 0 ? `${index + 1}. ` : ""}{item.title}{index === 0 && kind === "image" ? (de ? " · Titelbild" : " · Cover") : ""}</span></label>
        {item.mimeType === "application/pdf" ? <p className="mt-2 rounded-md bg-white p-3 text-sm">{de ? "PDF-Grundriss · vollständige Seiten im Exposé" : "PDF floor plan · full pages in the brochure"}</p>
          : item.url ? <Image unoptimized src={item.url} alt={item.title} width={320} height={180} className={`mt-2 h-32 w-full rounded bg-white ${kind === "floorplan" ? "object-contain" : "object-cover"}`} /> : null}
        {index >= 0 ? <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || index === 0} aria-label={`${de ? "Nach vorne" : "Move earlier"}: ${item.title}`} onClick={() => move(index, -1)}>↑</button><button type="button" className={buttonClass} disabled={disabled || index === selected.length - 1} aria-label={`${de ? "Nach hinten" : "Move later"}: ${item.title}`} onClick={() => move(index, 1)}>↓</button></div> : null}
      </li>;
    })}</ul>}
  </fieldset>;
}
