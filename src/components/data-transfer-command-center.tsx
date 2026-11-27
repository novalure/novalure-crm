"use client";

import { useRef, useState } from "react";
import type { Project } from "@/lib/crm-types";
import { CRM_TRANSFER_MAX_BYTES, crmTransferFields, parseCrmCsv, suggestCrmTransferMapping, type CrmTransferField, type CrmTransferMapping, type CrmTransferPreview } from "@/lib/crm-transfer";
import { csrfFetch } from "@/lib/security/csrf-client";

type Props = { workspaceId: string; activeProjectId: string | null; projects: Project[]; language: "de" | "en"; canImport: boolean; onChanged?: () => void | Promise<void> };
const fieldLabels: Record<CrmTransferField, [string, string]> = { name: ["Name", "Name"], email: ["E-Mail", "Email"], phone: ["Telefon", "Phone"], role: ["Rolle", "Role"], source: ["Quelle", "Source"], intent: ["Anliegen", "Enquiry"], externalId: ["Original-ID", "Original ID"] };
export function DataTransferCommandCenter(props: Props) { return <TransferSession key={props.workspaceId} {...props} />; }

function TransferSession({ workspaceId, activeProjectId, projects, language, canImport, onChanged }: Props) {
  const de = language === "de", t = (german: string, english: string) => de ? german : english;
  const [projectId, setProjectId] = useState(activeProjectId ?? "");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<CrmTransferMapping>({});
  const [createLeads, setCreateLeads] = useState(false);
  const [preview, setPreview] = useState<CrmTransferPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [committed, setCommitted] = useState(false);
  const pending = useRef<{ body: string; key: string; correlation: string } | null>(null);
  const controlsLocked = busy || uncertain;
  const endpoint = `/api/crm/transfer?workspaceId=${encodeURIComponent(workspaceId)}`;
  const projectOptions = projects.filter(project => project.workspaceId === workspaceId);

  async function openFile(file?: File) {
    if (!file || controlsLocked) return;
    setPreview(null); setCommitted(false); setNotice("");
    try {
      if (file.size > CRM_TRANSFER_MAX_BYTES) throw new Error(t("Die Datei ist größer als 2 MB.", "The file exceeds 2 MB."));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const parsed = parseCrmCsv(text);
      setCsv(text); setFileName(file.name); setHeaders(parsed.headers); setMapping(suggestCrmTransferMapping(parsed.headers));
    } catch (error) { setCsv(""); setFileName(""); setHeaders([]); setNotice(error instanceof Error ? error.message : t("Die Datei konnte nicht gelesen werden.", "The file could not be read.")); }
  }

  async function runPreview() {
    if (controlsLocked || !csv || !projectId) return;
    setBusy(true); setNotice(""); setPreview(null);
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", csv, mapping, projectId, createLeads }) });
      const result = await response.json() as { preview?: CrmTransferPreview; error?: string };
      if (!response.ok || !result.preview) throw new Error(result.error || t("Die Vorschau ist nicht verfügbar.", "Preview is unavailable."));
      setPreview(result.preview);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Die Vorschau ist nicht verfügbar.", "Preview is unavailable.")); }
    finally { setBusy(false); }
  }

  async function commitImport() {
    if (busy || committed || (!uncertain && (!preview || preview.invalid || !preview.ready))) return;
    const attempt = pending.current ?? { body: JSON.stringify({ action: "commit", csv, mapping, projectId, createLeads }), key: crypto.randomUUID(), correlation: crypto.randomUUID() };
    pending.current = attempt; setBusy(true); setNotice("");
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": attempt.key, "X-Correlation-Id": attempt.correlation }, body: attempt.body });
      if (response.status >= 500) throw new Error("unknown");
      const result = await response.json() as { persisted?: boolean; created?: unknown[]; skippedDuplicates?: number; error?: string };
      if (!response.ok) { pending.current = null; setUncertain(false); throw new Error(result.error || t("Import abgelehnt.", "Import rejected.")); }
      if (result.persisted !== true || !Array.isArray(result.created)) throw new Error("unknown");
      pending.current = null; setUncertain(false); setCommitted(true);
      const message = t(`${result.created.length} Kontakte gespeichert, ${result.skippedDuplicates ?? 0} Dubletten übersprungen.`, `${result.created.length} contacts saved, ${result.skippedDuplicates ?? 0} duplicates skipped.`);
      setNotice(message);
      try { await onChanged?.(); }
      catch { setNotice(message + " " + t("Bitte die Ansicht neu laden.", "Please reload the view.")); }
    } catch (error) {
      if (pending.current) { setUncertain(true); setNotice(t("Das Ergebnis ist noch ungeklärt. Mit „Ergebnis erneut prüfen“ denselben Import wiederholen; er wird nur einmal gespeichert. Diesen Dialog bis zur Klärung offen halten.", "The result is still unknown. Retry the same import with ‘Check result again’; it will be saved once. Keep this dialog open until resolved.")); }
      else setNotice(error instanceof Error ? error.message : t("Import abgelehnt.", "Import rejected."));
    } finally { setBusy(false); }
  }

  async function download(kind: "contacts" | "leads", format: "csv" | "vcf") {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const query = new URLSearchParams({ workspaceId, kind, format });
      if (projectId) query.set("projectId", projectId);
      const response = await fetch(`/api/crm/transfer?${query}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error || t("Export fehlgeschlagen.", "Export failed.")); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || `novalure-${kind}.${format}`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(t(`${response.headers.get("x-novalure-record-count") ?? ""} Datensätze exportiert.`, `${response.headers.get("x-novalure-record-count") ?? ""} records exported.`));
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Export fehlgeschlagen.", "Export failed.")); }
    finally { setBusy(false); }
  }

  return <section className="space-y-5" aria-labelledby="crm-transfer-title">
    <div><h2 id="crm-transfer-title" className="text-xl font-semibold">{t("Daten übertragen", "Transfer data")}</h2><p className="mt-1 text-sm text-slate-500">{t("Kontakte und Leads mitnehmen oder geprüfte Kontakte aus CSV anlegen.", "Export contacts and leads or import reviewed contacts from CSV.")}</p></div>
    <label className="grid max-w-md gap-1 text-sm">{t("Projekt", "Project")}<select className="rounded-lg border border-slate-200 bg-white p-2.5" value={projectId} disabled={controlsLocked} onChange={event => { setProjectId(event.target.value); setPreview(null); setCommitted(false); }}><option value="">{t("Alle sichtbaren Projekte (Export)", "All accessible projects (export)")}</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <div className="rounded-xl border border-slate-200 p-4"><h3 className="font-medium">{t("Export", "Export")}</h3><p className="mt-1 text-sm text-slate-500">{t("Der Export enthält nur Datensätze, auf die du Zugriff hast. CSV enthält Original-IDs; vCard enthält Name und Kontaktdaten.", "Exports include only accessible records. CSV includes original IDs; vCard includes names and contact details.")}</p><div className="mt-3 flex flex-wrap gap-2">{([["contacts", "csv", "Kontakte als CSV", "Contacts as CSV"], ["leads", "csv", "Leads als CSV", "Leads as CSV"], ["contacts", "vcf", "Kontakte als vCard", "Contacts as vCard"]] as const).map(([kind, format, german, english]) => <button type="button" className="min-h-11 rounded-lg border border-slate-200 px-4 py-2 text-sm disabled:opacity-50" key={kind + format} disabled={busy} onClick={() => void download(kind, format)}>{t(german, english)}</button>)}</div></div>
    {canImport && <div className="space-y-4 rounded-xl border border-slate-200 p-4"><div><h3 className="font-medium">{t("CSV importieren", "Import CSV")}</h3><p className="mt-1 text-sm text-slate-500">{t("Bis zu 1.000 Zeilen, UTF-8, 2 MB. Vorhandene E-Mail-Adressen und Telefonnummern werden übersprungen. Bestehende Kontakte und Einwilligungen werden nicht geändert.", "Up to 1,000 rows, UTF-8, 2 MB. Existing email addresses and phone numbers are skipped. Existing contacts and consent records remain unchanged.")}</p></div>
      <label className="grid gap-1 text-sm">{t("CSV-Datei", "CSV file")}<input type="file" accept=".csv,text/csv" disabled={controlsLocked} onChange={event => void openFile(event.target.files?.[0])} /></label>
      {fileName && <p className="text-sm">{fileName}</p>}
      {headers.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{crmTransferFields.map(field => <label key={field} className="grid gap-1 text-sm">{fieldLabels[field][de ? 0 : 1]}<select className="rounded-lg border border-slate-200 bg-white p-2.5" disabled={controlsLocked} value={mapping[field] ?? ""} onChange={event => { setMapping(current => ({ ...current, [field]: event.target.value })); setPreview(null); setCommitted(false); }}><option value="">{t("Nicht übernehmen", "Do not import")}</option>{headers.map(header => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createLeads} disabled={controlsLocked} onChange={event => { setCreateLeads(event.target.checked); setPreview(null); setCommitted(false); }} />{t("Für jeden neuen Kontakt zusätzlich einen Lead im Status Neu anlegen", "Also create a new lead for each imported contact")}</label>
      {!projectId && <p className="text-sm text-amber-700">{t("Für den Import ein Zielprojekt auswählen.", "Select a target project for the import.")}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded-lg border border-slate-200 px-4 py-2 text-sm disabled:opacity-50" disabled={controlsLocked || !csv || !projectId} onClick={() => void runPreview()}>{t("Vorschau prüfen", "Review preview")}</button><button type="button" className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy || committed || (!uncertain && (!preview || preview.invalid > 0 || preview.ready === 0))} onClick={() => void commitImport()}>{uncertain ? t("Ergebnis erneut prüfen", "Check result again") : t("Geprüfte Kontakte importieren", "Import reviewed contacts")}</button></div>
      {preview && <div><p className="mb-3 text-sm">{t(`${preview.ready} neu · ${preview.duplicates} Dubletten · ${preview.invalid} fehlerhaft`, `${preview.ready} new · ${preview.duplicates} duplicates · ${preview.invalid} invalid`)}</p><div className="max-h-80 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-50"><tr>{[t("Zeile", "Row"), "Name", "E-Mail", t("Ergebnis", "Result")].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead><tbody>{preview.rows.map(row => <tr className="border-t border-slate-100" key={row.line}><td className="p-2">{row.line}</td><td className="p-2">{row.contact.name}</td><td className="p-2">{row.contact.email || row.contact.phone}</td><td className="p-2">{row.status === "ready" ? t("Neu", "New") : row.status === "duplicate" ? t("Übersprungen: Dublette", "Skipped: duplicate") : row.issues.join(" ")}</td></tr>)}</tbody></table></div></div>}
    </div>}
    {notice && <p className="rounded-lg bg-slate-50 p-3 text-sm" role="status" aria-live="polite">{notice}</p>}
  </section>;
}
