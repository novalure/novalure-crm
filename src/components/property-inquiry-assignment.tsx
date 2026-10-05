"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PropertyUnit } from "@/lib/crm-types";
import type { PropertyAssetSummary } from "@/lib/property-department";
import { inquiryAssignmentTargets, isConfirmedInquiryResponse, type PropertyInquiryCandidate } from "@/lib/property-inquiry-assignment";
import { propertyWorkspaceEndpoint } from "@/lib/property-interactions";
import { csrfFetch } from "@/lib/security/csrf-client";
import { getCrmSystemTextLabel, type LanguageCode } from "@/lib/i18n";

type Props = {
  language: LanguageCode;
  workspaceId: string;
  activeProjectId?: string | null;
  assets: PropertyAssetSummary[];
  units: PropertyUnit[];
  canAssign: boolean;
  disabledReason?: string;
  isMutationBusy: boolean;
  acquireMutation: () => symbol | null;
  releaseMutation: (token: symbol) => unknown;
  onRefresh?: () => void | Promise<void>;
  suggestions?: { leadId: string; label: string }[];
};

const controlClass = "min-h-11 min-w-0 w-full rounded-md border border-stone-300 bg-white p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-60";
const focusClass = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

export function PropertyInquiryAssignment(props: Props) {
  return <PropertyInquiryAssignmentScope key={`${props.workspaceId}:${props.activeProjectId ?? "all"}`} {...props} />;
}

function PropertyInquiryAssignmentScope({
  language, workspaceId, activeProjectId, assets, units, canAssign, disabledReason,
  isMutationBusy, acquireMutation, releaseMutation, onRefresh, suggestions = [],
}: Props) {
  const de = language === "de";
  const helpId = useId();
  const targetHelpId = useId();
  const unitHelpId = useId();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [candidates, setCandidates] = useState<PropertyInquiryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [leadId, setLeadId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const endpoint = propertyWorkspaceEndpoint("/api/crm/properties", workspaceId);
  useEffect(() => { if (notice?.error) noticeRef.current?.focus(); }, [notice]);

  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const response = await fetch(`${endpoint}&operation=inquiry_assignments${activeProjectId ? `&projectId=${encodeURIComponent(activeProjectId)}` : ""}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || payload.persisted !== true || !Array.isArray(payload.data?.candidates)) throw new Error("Assignments could not be loaded");
    if (mounted.current && generation.current === requestGeneration) {
      setCandidates(payload.data.candidates);
      setLoadFailed(false);
    }
  }, [endpoint, activeProjectId]);

  useEffect(() => {
    mounted.current = true;
    void reload().catch(() => {
      if (mounted.current) setLoadFailed(true);
    }).finally(() => {
      if (mounted.current) setLoading(false);
    });
    return () => { mounted.current = false; generation.current += 1; };
  }, [reload]);

  const candidate = candidates.find((entry) => entry.leadId === leadId);
  const targets = candidate ? inquiryAssignmentTargets(assets, workspaceId, candidate.projectId) : [];
  const target = targets.find((asset) => asset.sellerListingId === propertyId);
  const targetUnits = target ? units.filter((unit) => unit.workspaceId === workspaceId &&
    unit.projectId === target.projectId && target.unitIds.includes(unit.id)) : [];
  const unchanged = candidate?.assignment?.propertyId === propertyId && (candidate.assignment.unitId ?? "") === unitId;
  const assignmentLabel = (entry: PropertyInquiryCandidate) => entry.assignment
    ? `${entry.assignment.propertyTitle || (de ? "Ziel nicht mehr verfügbar" : "Target no longer available")}${entry.assignment.unitNumber ? ` · ${de ? "Einheit" : "Unit"} ${entry.assignment.unitNumber}` : ""}`
    : de ? "Noch keine bestätigte Zuordnung" : "No confirmed assignment yet";

  async function submitAssignment() {
    if (!canAssign || loading || loadFailed || !candidate || !target || unchanged || isMutationBusy) return;
    if (unitId && !targetUnits.some((unit) => unit.id === unitId)) return;
    const unitName = targetUnits.find((unit) => unit.id === unitId)?.unitNumber;
    const targetName = `${target.title}${unitName ? ` · ${de ? "Einheit" : "Unit"} ${unitName}` : ""}`;
    if (!window.confirm(de
      ? `Anfrage von ${candidate.contactName} verbindlich der Immobilie „${targetName}“ zuordnen?${candidate.assignment ? ` Die bisherige Zuordnung „${assignmentLabel(candidate)}“ wird ersetzt.` : ""} Es wird kein Deal und keine Reservierung angelegt.`
      : `Confirm assigning ${candidate.contactName}'s inquiry to “${targetName}”?${candidate.assignment ? ` This replaces “${assignmentLabel(candidate)}”.` : ""} No deal or reservation will be created.`)) return;
    const token = acquireMutation();
    if (!token) return;
    const scopeGeneration = generation.current;
    const canUpdate = () => mounted.current && generation.current === scopeGeneration;
    setNotice(null);
    try {
      const response = await csrfFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "assign_inquiry", leadId: candidate.leadId, propertyId,
          unitId: unitId || null, expectedVersion: candidate.assignment?.version ?? null, confirmed: true }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isConfirmedInquiryResponse(payload, candidate.leadId, propertyId, unitId || null)) {
        throw new Error(de ? "Zuordnung nicht bestätigt. Bitte den Stand neu laden und erneut prüfen." : "Assignment not confirmed. Reload the current state and review again.");
      }
      if (canUpdate()) {
        setCandidates((current) => current.map((entry) => entry.leadId === candidate.leadId ? payload.data : entry));
        setNotice({ error: false, text: de ? `Gespeichert: ${candidate.contactName} → ${targetName}.` : `Saved: ${candidate.contactName} → ${targetName}.` });
      }
      try {
        await onRefresh?.();
      } catch {
        if (canUpdate()) setNotice({ error: false, text: de
          ? "Die Zuordnung wurde gespeichert. Andere CRM-Ansichten konnten nicht aktualisiert werden. Bitte neu laden; nicht erneut zuordnen."
          : "The assignment was saved. Other CRM views could not be refreshed. Reload; do not assign again." });
      }
    } catch (error) {
      if (canUpdate()) setNotice({ error: true, text: error instanceof Error ? error.message : de ? "Zuordnung konnte nicht bestätigt werden." : "Assignment could not be confirmed." });
    } finally {
      releaseMutation(token);
    }
  }

  async function refreshAssignments() {
    setLoading(true);
    setNotice(null);
    try { await reload(); }
    catch { if (mounted.current) setLoadFailed(true); }
    finally { if (mounted.current) setLoading(false); }
  }

  return <section aria-label={de ? "Anfragen zu Immobilien zuordnen" : "Assign inquiries to properties"} className="mt-4 grid min-w-0 gap-4">
    <p id={helpId} className="text-sm text-stone-600">{de
      ? "Vorschläge sind noch keine gespeicherten Beziehungen. Eine bestätigte Zuordnung verknüpft eine vorhandene Anfrage mit einer gespeicherten Immobilie im selben Projekt. Leads, Käufer, Deals und Reservierungen werden dabei nicht verändert."
      : "Suggestions are not saved relationships. A confirmed assignment links an existing inquiry to a saved property in the same project. Leads, buyers, deals and reservations are not changed."}</p>
    {notice ? <p ref={noticeRef} tabIndex={-1} aria-atomic="true" className={`break-words rounded-md border p-3 text-sm ${focusClass} ${notice.error ? "border-red-200 bg-red-50 text-red-800" : "border-stone-200 bg-stone-50 text-stone-800"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
    {loadFailed ? <p className="text-sm text-red-800" role="alert">{de ? "Gespeicherte Zuordnungen konnten nicht geladen werden. Zuordnen bleibt gesperrt, bis der Datenbankstand wieder verfügbar ist." : "Saved assignments could not be loaded. Assignment is disabled until the database state is available."}</p> : null}
    <button className={`min-h-11 justify-self-start rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`} disabled={isMutationBusy || loading} onClick={() => void refreshAssignments()} type="button">{loading ? (de ? "Lädt …" : "Loading …") : (de ? "Zuordnungen neu laden" : "Reload assignments")}</button>
    <p role="status" aria-atomic="true" className="text-sm text-stone-600">{loading
      ? (de ? "Gespeicherte Anfragen und Zuordnungen werden geladen …" : "Loading saved inquiries and assignments …")
      : loadFailed ? (de ? "Aktueller Datenstand nicht verfügbar. Bitte erneut laden." : "Current data is unavailable. Please reload.")
      : candidates.length ? (de ? `${candidates.length} Anfragen im aktuellen Projektfilter.` : `${candidates.length} inquiries in the current project filter.`)
      : (de ? "Keine sichtbaren Anfragen mit zugehörigem Kontakt in diesem Projektfilter. Prüfe den Projektfilter oder lege zuerst eine Anfrage mit Kontakt an." : "No visible inquiries with an associated contact in this project filter. Check the project filter or create an inquiry with a contact first.")}</p>
    {!loading && !loadFailed && candidates.length > 0 ? <ul aria-label={de ? "Gespeicherte Anfragen" : "Saved inquiries"} className="grid min-w-0 gap-3">
      {candidates.map((entry) => <li className="min-w-0 rounded-xl border border-stone-200 bg-white p-3" key={entry.leadId}>
        <dl className="grid min-w-0 gap-3 text-sm md:grid-cols-3">
          <div className="min-w-0 break-words"><dt className="text-xs font-semibold text-stone-600">{de ? "Anfrage / Kontakt" : "Inquiry / contact"}</dt><dd className="mt-1"><p className="font-semibold">{entry.contactName}</p><p>{getCrmSystemTextLabel(entry.intent, language)}</p><p className="text-xs text-stone-600">{entry.projectName || (de ? "Ohne Projekt" : "No project")} · {getCrmSystemTextLabel(entry.source, language)}</p></dd></div>
          <div className="min-w-0 break-words"><dt className="text-xs font-semibold text-stone-600">{de ? "Gespeicherte Zuordnung" : "Saved assignment"}</dt><dd className="mt-1">{assignmentLabel(entry)}</dd></div>
          <div className="min-w-0 break-words"><dt className="text-xs font-semibold text-stone-600">{de ? "Vorschlag – nicht gespeichert" : "Suggestion – not saved"}</dt><dd className="mt-1 text-stone-600">{suggestions.find((suggestion) => suggestion.leadId === entry.leadId)?.label || (de ? "Manuell prüfen" : "Review manually")}</dd></div>
        </dl>
      </li>)}
    </ul> : null}
    <form aria-label={de ? "Anfrage verbindlich zuordnen" : "Confirm inquiry assignment"} aria-describedby={helpId} aria-busy={isMutationBusy || loading} onSubmit={(event) => { event.preventDefault(); void submitAssignment(); }} className="grid min-w-0 gap-3 rounded-md border border-stone-200 bg-stone-50 p-4 md:grid-cols-3">
      <label className="grid min-w-0 content-start gap-1 text-sm font-semibold">{de ? "1. Anfrage auswählen" : "1. Select inquiry"}
        <select className={controlClass} name="inquiry" required disabled={isMutationBusy || loading || loadFailed || !canAssign || !candidates.length} value={leadId} onChange={(event) => {
          const next = candidates.find((entry) => entry.leadId === event.target.value);
          setLeadId(event.target.value); setPropertyId(next?.assignment?.propertyId ?? ""); setUnitId(next?.assignment?.unitId ?? ""); setNotice(null);
        }}><option value="">{de ? "Bitte auswählen" : "Please select"}</option>{candidates.map((entry) => <option key={entry.leadId} value={entry.leadId}>{entry.contactName} · {getCrmSystemTextLabel(entry.intent, language)}</option>)}</select>
      </label>
      <label className="grid min-w-0 content-start gap-1 text-sm font-semibold">{de ? "2. Gespeicherte Immobilie" : "2. Saved property"}
        <select className={controlClass} name="property" required aria-describedby={targetHelpId} disabled={isMutationBusy || loading || !candidate || !canAssign || loadFailed || !targets.length} value={target ? propertyId : ""} onChange={(event) => { setPropertyId(event.target.value); setUnitId(""); setNotice(null); }}>
          <option value="">{de ? "Bitte auswählen" : "Please select"}</option>{targets.map((asset) => <option key={asset.id} value={asset.sellerListingId}>{asset.title} · {asset.projectName}</option>)}
        </select>
      </label>
      <label className="grid min-w-0 content-start gap-1 text-sm font-semibold">{de ? "3. Verknüpfte Einheit (optional)" : "3. Linked unit (optional)"}
        <select className={controlClass} name="unit" aria-describedby={unitHelpId} disabled={isMutationBusy || loading || !target || !canAssign || loadFailed || !targetUnits.length} value={unitId} onChange={(event) => { setUnitId(event.target.value); setNotice(null); }}>
          <option value="">{de ? "Nur Immobilie, keine Einheit" : "Property only, no unit"}</option>{targetUnits.map((unit) => <option key={unit.id} value={unit.id}>{de ? "Einheit" : "Unit"} {unit.unitNumber}</option>)}
        </select>
      </label>
      <p id={targetHelpId} className="text-sm text-stone-600 md:col-span-3">{de ? "Es werden nur gespeicherte Immobilien im Projekt der gewählten Anfrage angeboten." : "Only saved properties in the selected inquiry's project are available."}</p>
      <p id={unitHelpId} className="text-sm text-stone-600 md:col-span-3">{target && !targetUnits.length ? (de ? "Keine Einheit mit dieser Immobilie verknüpft. Die Anfrage kann der Immobilie allein zugeordnet werden." : "No unit is linked to this property. The inquiry can be assigned to the property alone.") : (de ? "Optional: eine bereits mit dieser Immobilie verknüpfte Einheit auswählen. Es wird keine Reservierung angelegt." : "Optional: choose a unit already linked to this property. No reservation is created.")}</p>
      {candidate && !targets.length ? <p className="text-sm text-stone-600 md:col-span-3">{de ? "Keine gespeicherte Immobilie im selben Projekt verfügbar. Bitte zuerst das passende Objekt anlegen; die Projektzuordnung des Leads wird hier nicht automatisch geändert." : "No saved property is available in the same project. Create the matching property first; the lead's project is never changed automatically here."}</p> : null}
      {!canAssign ? <p className="text-sm text-stone-600 md:col-span-3">{disabledReason || (de ? "Keine Berechtigung zum Zuordnen." : "Assignment permission is required.")}</p> : null}
      {unchanged ? <p role="status" className="text-sm text-stone-600 md:col-span-3">{de ? "Diese Zuordnung ist bereits gespeichert. Wähle ein anderes Ziel, wenn du sie ändern möchtest." : "This assignment is already saved. Choose a different target to change it."}</p> : null}
      <button className={`min-h-11 justify-self-start rounded-md bg-[var(--brand-primary,#f6d95d)] px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 md:col-span-3 ${focusClass}`} disabled={!canAssign || loading || loadFailed || !candidate || !target || unchanged || isMutationBusy} type="submit">{de ? (candidate?.assignment ? "Neue Zuordnung bestätigen und speichern" : "Zuordnung bestätigen und speichern") : (candidate?.assignment ? "Confirm and save reassignment" : "Confirm and save assignment")}</button>
    </form>
  </section>;
}
