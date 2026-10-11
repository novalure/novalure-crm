"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SellerListing } from "@/lib/crm-types";
import { createPropertyDraftStore, type PropertyDraftStore } from "@/lib/property-draft-store";
import { usePropertyDraft } from "@/lib/use-property-draft";
import { csrfFetch } from "@/lib/security/csrf-client";
import { createPropertyRelationshipDraft, propertyRelationshipDraftKey, propertyRelationshipOptions, propertyRelationshipUpdatePayload,
  savePropertyRelationshipDraft, emptyPropertyRelationshipOptions, fetchPropertyRelationshipOptions,
  type PropertyRelationshipOptions, type PropertyRelationshipSources } from "@/lib/property-relationship-editing";
import { normalizePropertyRelationshipSnapshot, propertyRelationshipKeys, type PropertyRelationshipKey } from "@/lib/property-relationship-snapshot";

export type PropertyRelationshipEditorProps = PropertyRelationshipSources & {
  listing: SellerListing; workspaceId: string; language: string; canEdit: boolean;
  draftStore?: PropertyDraftStore; draftUserId?: string; onChanged: () => void | Promise<void>; onClose: () => void;
};
const control = "mt-1 min-h-11 min-w-0 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-60";
const button = "min-h-11 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50";
export function PropertyRelationshipEditor(props: PropertyRelationshipEditorProps) {
  if (props.listing.workspaceId !== props.workspaceId || !normalizePropertyRelationshipSnapshot({ id: props.listing.id, workspaceId: props.workspaceId, projectId: props.listing.projectId || null,
    ...Object.fromEntries(propertyRelationshipKeys.map(key => [key, props.listing[key] || null])) })) return <p role="alert">{props.language === "de" ? "Kein gültiges gespeichertes Objekt in diesem Workspace ausgewählt." : "No valid saved property selected in this workspace."}</p>;
  return <RelationshipForm key={`${props.workspaceId}:${props.listing.id}`} {...props} />;
}
function RelationshipForm({ listing, workspaceId, language, canEdit, draftStore: suppliedStore, draftUserId = "current-user", onChanged, onClose, ...sources }: PropertyRelationshipEditorProps) {
  const de = language === "de", headingId = useId(), helpId = useId();
  const sectionRef = useRef<HTMLElement>(null), headingRef = useRef<HTMLHeadingElement>(null), noticeRef = useRef<HTMLParagraphElement>(null), mounted = useRef(false);
  const [standalone] = useState(createPropertyDraftStore), store = suppliedStore ?? standalone;
  const [initial, setInitial] = useState(() => createPropertyRelationshipDraft(listing));
  const scopeKey = propertyRelationshipDraftKey(draftUserId, workspaceId, listing.id);
  const { draft, setDraft, resetDraft, isDraftDirty, isMutationBusy } = usePropertyDraft(store, scopeKey, initial);
  const [notice, setNotice] = useState<{ error: boolean; conflict?: boolean; text: string } | null>(null);
  const expected = normalizePropertyRelationshipSnapshot(draft.coreEdit?.expected)!;
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [loadedOptions, setLoadedOptions] = useState<{ key: string; options: PropertyRelationshipOptions } | null>(null);
  const [optionsErrorKey, setOptionsErrorKey] = useState<string | null>(null);
  const optionsKey = JSON.stringify([workspaceId, listing.id, expected.projectId, listing.projectId || null, optionsAttempt, canEdit]);
  const optionsReady = canEdit && loadedOptions?.key === optionsKey;
  const optionsFailed = optionsErrorKey === optionsKey;
  const allOptions = optionsReady ? loadedOptions.options : emptyPropertyRelationshipOptions();
  const options = { ...allOptions, mandateId: allOptions.mandateId.filter(option => !draft.fieldValues.sellerLeadId || !option.sellerLeadId || option.sellerLeadId === draft.fieldValues.sellerLeadId) };
  // Old props may describe saved labels, but never authorize a new selectable value.
  const displayOptions = propertyRelationshipOptions(sources, workspaceId, expected.projectId, draft.fieldValues.sellerLeadId);
  useEffect(() => {
    if (!canEdit) return;
    let current = true; const controller = new AbortController();
    void fetchPropertyRelationshipOptions({ workspaceId, propertyId: listing.id, projectId: expected.projectId, signal: controller.signal, request: (url, init) => fetch(url, init) })
      .then(value => { if (current) setLoadedOptions({ key: optionsKey, options: value }); })
      .catch(() => { if (current) setOptionsErrorKey(optionsKey); });
    return () => { current = false; controller.abort(); };
  }, [canEdit, workspaceId, listing.id, expected.projectId, optionsKey]);
  const labels: Record<PropertyRelationshipKey, string> = de ? { sellerLeadId: "Verkäufer-Lead", mandateId: "Maklermandat", ownerContactId: "Eigentümerkontakt", ownerUserId: "Verantwortliche Person im Team", contactUserId: "Ansprechperson im Team" }
    : { sellerLeadId: "Seller lead", mandateId: "Broker mandate", ownerContactId: "Owner contact", ownerUserId: "Responsible team member", contactUserId: "Contact team member" };
  const noLink = de ? "Nicht verknüpft" : "Not linked";
  const labelFor = (key: PropertyRelationshipKey, value: string | null) => !value ? noLink : options[key].find(option => option.id === value)?.label || displayOptions[key].find(option => option.id === value)?.label || (de ? "Gespeicherter Wert nicht in der aktuellen Auswahl verfügbar" : "Saved value unavailable in current selection");
  let invalid = false;
  if (isDraftDirty && optionsReady) { try { propertyRelationshipUpdatePayload(draft, workspaceId, listing.id, options); } catch { invalid = true; } }
  const disabled = !canEdit || isMutationBusy || !optionsReady;
  useEffect(() => {
    mounted.current = true; const opener = document.activeElement, section = sectionRef.current; headingRef.current?.focus();
    return () => { mounted.current = false; if (opener instanceof HTMLElement && opener.isConnected && (document.activeElement === document.body || section?.contains(document.activeElement))) opener.focus(); };
  }, []);
  useEffect(() => { if (notice?.error || optionsFailed) noticeRef.current?.focus(); }, [notice, optionsFailed]);
  useEffect(() => {
    if (suppliedStore) return;
    const protect = (event: BeforeUnloadEvent) => { if (store.hasDrafts() || store.isMutationBusy()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [store, suppliedStore]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !isDraftDirty || invalid) return;
    const changed = propertyRelationshipKeys.filter(key => (draft.fieldValues[key] || null) !== expected[key]);
    if (!window.confirm(`${de ? "Diese Verknüpfungen verbindlich speichern?" : "Save these relationships?"}\n${changed.map(key => `${labels[key]}: ${labelFor(key, expected[key])} → ${labelFor(key, draft.fieldValues[key])}`).join("\n")}\n${de ? "Projekt, Einheit, Preise und Veröffentlichung bleiben unverändert." : "Project, unit, prices and publication remain unchanged."}`)) return;
    setNotice(null);
    try {
      const result = await savePropertyRelationshipDraft({ draft, workspaceId, propertyId: listing.id, scopeKey, store, options, request: csrfFetch, onChanged });
      if (!mounted.current || result.kind === "busy") return;
      setInitial(createPropertyRelationshipDraft(result.listing));
      setNotice({ error: false, text: result.kind === "saved_refresh_failed" ? (de ? "Verknüpfungen gespeichert. Andere Ansichten konnten nicht aktualisiert werden. Bitte neu laden, nicht nochmals speichern." : "Relationships saved. Other views could not refresh. Reload; do not save again.") : (de ? "Verknüpfungen bestätigt gespeichert." : "Relationships confirmed saved.") });
    } catch (error) {
      if (!mounted.current) return; const conflict = error instanceof Error && error.message === "property_relationship_conflict";
      setNotice({ error: true, conflict, text: conflict ? (de ? "Die Verknüpfungen oder das Projekt wurden zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Aktuellen Stand neu laden und prüfen." : "Relationships or the project changed in the meantime. Your draft is retained. Reload and review the current state.")
        : (de ? "Speicherung nicht bestätigt. Dein Entwurf bleibt erhalten. Prüfe Verknüpfungen und Berechtigungen; lade bei Bedarf neu." : "Save not confirmed. Your draft is retained. Check relationships and permissions; reload if needed.") });
    }
  }
  async function discardAndReload() {
    if (disabled || !window.confirm(de ? "Entwurf verwerfen und aktuelle Verknüpfungen neu laden?" : "Discard this draft and reload current relationships?")) return;
    try { await onChanged(); resetDraft(); onClose(); } catch { if (mounted.current) setNotice({ error: true, conflict: true, text: de ? "Aktualisierung fehlgeschlagen. Dein Entwurf bleibt erhalten." : "Refresh failed. Your draft is retained." }); }
  }
  return <section ref={sectionRef} aria-labelledby={headingId} className="min-w-0 rounded-2xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4">{de ? "Verknüpfungen bearbeiten" : "Edit relationships"}</h3><p className="mt-1 break-words text-sm text-slate-600">{listing.title}</p></div>
      <button type="button" disabled={isMutationBusy} className={button} onClick={onClose}>{de ? "Schließen – Entwurf behalten" : "Close – keep draft"}</button></div>
    <p id={helpId} className="mt-3 text-sm text-slate-600">{de ? "Verknüpft vorhandene Datensätze mit dieser Immobilie. Nur ausdrücklich geänderte Felder werden gespeichert. „Nicht verknüpft“ entfernt die jeweilige Beziehung, nicht den Datensatz. Projekt, Einheit, Preise und Veröffentlichung bleiben unverändert. Entwürfe bleiben nur im Arbeitsspeicher, nicht nach Neuladen oder Abmelden." : "Links existing records to this property. Only explicitly changed fields are saved. “Not linked” removes the relationship, not the record. Project, unit, prices and publication remain unchanged. Drafts remain in memory only, not after reload or sign-out."}</p>
    {!canEdit ? <p role="status" className="mt-3 text-sm text-amber-900">{de ? "Immobilien-Schreibrechte fehlen. Verknüpfungen können nur gelesen werden." : "Property write permission is required. Relationships are read-only."}</p> : null}
    {canEdit && !optionsReady ? <div className="mt-3">
      <p ref={optionsFailed ? noticeRef : undefined} tabIndex={optionsFailed ? -1 : undefined} role={optionsFailed ? "alert" : "status"} aria-atomic="true" className="text-sm text-slate-700">
        {optionsFailed ? (de ? "Verknüpfungsauswahl konnte nicht bestätigt geladen werden. Gespeicherte Werte und Entwurf bleiben erhalten; Speichern ist gesperrt." : "Relationship choices could not be confirmed. Saved values and your draft are retained; saving is disabled.") : (de ? "Berechtigte Verknüpfungen werden aus der Datenbank geladen …" : "Loading authorized relationships from the database …")}
      </p>
      {optionsFailed ? <button type="button" className={`${button} mt-2`} disabled={isMutationBusy} onClick={() => setOptionsAttempt(value => value + 1)}>{de ? "Verknüpfungsauswahl erneut laden" : "Reload relationship choices"}</button> : null}
    </div> : null}
    {notice ? <p ref={noticeRef} tabIndex={-1} aria-atomic="true" role={notice.error ? "alert" : "status"} className={`mt-3 break-words rounded-xl p-3 text-sm focus-visible:outline-2 ${notice.error ? "bg-red-50 text-red-900" : "bg-emerald-50 text-emerald-900"}`}>{notice.text}</p> : null}
    {notice?.conflict ? <button type="button" className={`${button} mt-3`} disabled={disabled} onClick={() => void discardAndReload()}>{de ? "Entwurf verwerfen und neu laden" : "Discard draft and reload"}</button> : null}
    <form aria-labelledby={headingId} aria-describedby={helpId} aria-busy={isMutationBusy || (canEdit && !optionsReady && !optionsFailed)} onSubmit={event => void save(event)} className="mt-4">
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 md:grid-cols-2"><legend className="sr-only">{de ? "Beziehungen dieser Immobilie" : "Property relationships"}</legend>
        {propertyRelationshipKeys.map(key => { const value = draft.fieldValues[key], unavailable = !!value && !options[key].some(option => option.id === value), detailId = `${headingId}-${key}-saved`; return <div className="min-w-0" key={key}>
          <label className="block min-w-0 text-sm font-semibold text-slate-700" htmlFor={`${headingId}-${key}`}>{labels[key]}</label>
          <select id={`${headingId}-${key}`} name={key} className={control} value={value} aria-describedby={detailId} onChange={event => { setDraft(current => ({ ...current, fieldValues: { ...current.fieldValues, [key]: event.target.value } })); setNotice(null); }}>
            <option value="">{noLink}</option>{unavailable ? <option value={value}>{de ? "Bisherige Auswahl nicht verfügbar – bleibt erhalten" : "Current selection unavailable – retained"}</option> : null}
            {options[key].map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select><p id={detailId} className="mt-1 break-words text-xs text-slate-600">{de ? "Gespeichert: " : "Saved: "}{labelFor(key, expected[key])}{unavailable ? (de ? ". Auswahl prüfen; es wird nichts automatisch entfernt." : ". Review the selection; nothing is removed automatically.") : ""}</p>
        </div>; })}
      </fieldset>
      {invalid ? <p role="alert" className="mt-3 text-sm text-red-900">{de ? "Die Auswahl passt nicht zusammen oder ist nicht mehr verfügbar. Prüfe Verkäufer-Lead und Mandat; entferne eine widersprüchliche Verknüpfung ausdrücklich oder wähle einen passenden Datensatz." : "The selection is incompatible or no longer available. Review seller lead and mandate; explicitly remove an incompatible relationship or choose a matching record."}</p> : null}
      <p role="status" aria-atomic="true" className="mt-3 text-sm text-slate-600">{isMutationBusy ? (de ? "Speichervorgang läuft …" : "Save in progress …") : isDraftDirty ? (de ? "Ungespeicherte Verknüpfungen." : "Unsaved relationships.") : (de ? "Keine ungespeicherten Verknüpfungen." : "No unsaved relationships.")}</p>
      <div className="mt-4 flex flex-wrap gap-3"><button type="submit" className={`${button} bg-[var(--brand-primary,#f6d95d)]`} disabled={disabled || invalid || !isDraftDirty}>{de ? "Verknüpfungen bestätigen und speichern" : "Confirm and save relationships"}</button>
        <button type="button" className={button} disabled={isMutationBusy || !isDraftDirty} onClick={() => { if (window.confirm(de ? "Ungespeicherte Verknüpfungen verwerfen?" : "Discard unsaved relationships?")) resetDraft(); }}>{de ? "Verknüpfungsentwurf verwerfen" : "Discard relationship draft"}</button></div>
    </form>
  </section>;
}
