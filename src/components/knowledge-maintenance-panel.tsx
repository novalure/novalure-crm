"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { LanguageCode } from "@/lib/i18n";
import { getKnowledgeMaintenanceCopy } from "@/lib/knowledge-center/maintenance-copy";
import { compareKnowledgeVersions } from "@/lib/knowledge-center/version-comparison";
import { createStructuredKnowledgeRows, knowledgeFieldLabel, serializeStructuredKnowledge, structuredKnowledgeSummary, type StructuredKnowledgeRow } from "@/lib/knowledge-center/templates";
import type { KnowledgeArea, KnowledgeCenterSnapshot, KnowledgeChangeProposal, KnowledgeMaintenanceConfiguration, KnowledgeSource, KnowledgeSourceType, KnowledgeWorkflowEvent } from "@/lib/knowledge-center/types";
import { csrfFetch } from "@/lib/security/csrf-client";

const inputClass = "min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:bg-stone-100";
const buttonClass = "min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900`;
const sourceTypes: KnowledgeSourceType[] = ["manual", "faq", "structured", "url", "file"];
type Copy = ReturnType<typeof getKnowledgeMaintenanceCopy>;
type ProposalStatus = "open" | "accepted" | "rejected" | "deferred";
type Proposal = KnowledgeChangeProposal;
type ReviewField = KnowledgeMaintenanceConfiguration["fields"][number];
type Configuration = KnowledgeMaintenanceConfiguration & { enabled?: boolean };
type MaintenanceEvent = KnowledgeWorkflowEvent & { actorName?: string | null };
type Workflow = { proposals: Proposal[]; events: MaintenanceEvent[]; configurations: Configuration[] };
type Action = (body: Record<string, unknown>, success: string) => Promise<boolean>;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-800"><span>{label}</span>{children}</label>;
}

function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-10 text-center"><p className="font-semibold text-slate-900">{title}</p>{description ? <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-600">{description}</p> : null}</div>;
}

function formatDate(value: unknown, language: LanguageCode): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Vienna" }).format(new Date(value));
}

function proposalTitle(kind: string, text: Copy): string {
  if (kind === "stale") return text.staleKind;
  const titles: Record<string, string> = {
    missing_verification_metadata: text.missing_verification_metadata,
    missing_required_field: text.missing_required_field, expired: text.expired,
    not_yet_valid: text.not_yet_valid, conflicting_fact: text.conflicting_fact,
    website_changed: text.website_changed, website_change: text.website_changed,
  };
  return titles[kind] ?? text.otherKind;
}

function statusTitle(status: ProposalStatus, text: Copy): string {
  return ({ open: text.open, accepted: text.acceptedStatus, rejected: text.rejectedStatus, deferred: text.deferredStatus })[status];
}

function eventTitle(event: MaintenanceEvent, text: Copy): string {
  const kind = event.eventType;
  const titles: Record<string, string> = {
    analyzed: text.analyzedEvent, analyze: text.analyzedEvent, maintenance_analyzed: text.analyzedEvent,
    proposal_created: text.proposalCreatedEvent, "proposal-create": text.proposalCreatedEvent,
    proposal_edited: text.proposalEditedEvent, "proposal-edit": text.proposalEditedEvent,
    proposal_accepted: text.proposalAcceptedEvent, "proposal-accept": text.proposalAcceptedEvent,
    proposal_rejected: text.proposalRejectedEvent, "proposal-reject": text.proposalRejectedEvent,
    proposal_deferred: text.proposalDeferredEvent, "proposal-defer": text.proposalDeferredEvent,
    configured: text.configuredEvent, configure: text.configuredEvent, configuration_updated: text.configuredEvent,
    source_updated: text.sourceUpdatedEvent, source_archived: text.sourceArchivedEvent,
    published: text.publicationEvent, publication: text.publicationEvent,
    monitoring_updated: text.monitoringEvent, website_changed: text.monitoringEvent,
    "knowledge.maintenance.analyzed": text.analyzedEvent,
    "knowledge.maintenance.completed": text.analyzedEvent,
    "knowledge.maintenance.configured": text.configuredEvent,
    "knowledge.proposal.created": text.proposalCreatedEvent,
    "knowledge.proposal.edit": text.proposalEditedEvent,
    "knowledge.proposal.accept": text.proposalAcceptedEvent,
    "knowledge.proposal.reject": text.proposalRejectedEvent,
    "knowledge.proposal.defer": text.proposalDeferredEvent,
    "knowledge.version.restored": text.restoredEvent,
    "knowledge.publication.revoked": text.revokedEvent,
    "knowledge.publication.published": text.publicationEvent,
    "knowledge.publication.submitted": text.submittedEvent,
    "knowledge.publication.reviewed": text.reviewedEvent,
    "knowledge.publication.approved": text.approvedEvent,
  };
  return titles[kind] ?? text.eventFallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function eventAreas(event: MaintenanceEvent, snapshot: KnowledgeCenterSnapshot): string[] {
  const area = snapshot.sources.find((source) => source.id === event.sourceId)?.areaId;
  return [...new Set([...(area ? [area] : []), ...(typeof event.details.areaId === "string" ? [event.details.areaId] : []), ...stringArray(event.details.areaIds)])];
}

function assignedAssistants(snapshot: KnowledgeCenterSnapshot, areaIds: string[], ids: string[] = []) {
  const assigned = new Set([...ids, ...snapshot.assignments.filter((item) => areaIds.includes(item.areaId)).map((item) => item.botId)]);
  return snapshot.bots.filter((bot) => assigned.has(bot.id)).map((bot) => bot.name);
}

function evidenceFields(proposal: Proposal): string[] {
  const fields = proposal.evidence?.fieldPaths;
  return Array.isArray(fields) ? fields.filter((value): value is string => typeof value === "string") : [];
}

function ProposalEvidence({ proposal, text, language }: { proposal: Proposal; text: Copy; language: LanguageCode }) {
  const evidence = proposal.evidence ?? {};
  const fields = evidenceFields(proposal);
  const summary = evidence.basis === "last_verified" ? text.basisVerified : evidence.basis === "approved_at" ? text.basisApproved : evidence.basis === "created_at" ? text.basisCreated : (proposal.kind === "website_changed" || proposal.kind === "website_change") ? text.websiteChangeEvidence : text.evidenceFallback;
  return <div className="rounded-lg bg-stone-50 p-3 text-sm leading-6 text-stone-700"><p className="font-semibold text-slate-900">{text.evidence}</p><p>{summary}</p>{fields.length ? <p className="mt-1"><span className="font-medium">{text.affectedFields}: </span>{fields.map((field) => knowledgeFieldLabel(field, language)).join(" · ")}</p> : null}{typeof evidence.distinctValues === "number" ? <p>{text.distinctValues}: {evidence.distinctValues}</p> : null}{typeof evidence.validAt === "string" ? <p>{text.validAt}: {formatDate(evidence.validAt, language)}</p> : null}</div>;
}

function ProposalEditor({ proposal, source, text, language, disabled, stale, onAction }: { proposal: Proposal; source: KnowledgeSource | undefined; text: Copy; language: LanguageCode; disabled: boolean; stale: boolean; onAction: Action }) {
  const sourceVersion = source?.version?.id === proposal.versionId ? source.version : undefined;
  const base = proposal.changes.structuredData ?? sourceVersion?.structuredData ?? {};
  const initialName = proposal.changes.name ?? sourceVersion?.name ?? source?.name ?? "";
  const initialContent = proposal.changes.content ?? sourceVersion?.content ?? "";
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [rows, setRows] = useState<StructuredKnowledgeRow[]>(() => createStructuredKnowledgeRows(base));
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState("");
  const fieldId = useId();
  let structuredData = base;
  let valid = true;
  try { structuredData = serializeStructuredKnowledge(base, rows, removedKeys); } catch { valid = false; }
  const dirty = name !== initialName || content !== initialContent || JSON.stringify(structuredData) !== JSON.stringify(base) || !valid;
  const active = proposal.status === "open" || proposal.status === "deferred";
  const differences = !stale && source?.version ? compareKnowledgeVersions(source.version, { ...source.version, name, content, structuredData }) : [];
  const comparisonField = (field: string) => field === "name" ? text.name : field === "content" ? text.comparisonContent : knowledgeFieldLabel(field.replace(/^structured\./, ""), language);

  if (!active) return <div className="mt-4 space-y-3 border-t border-stone-200 pt-4">{proposal.changes.name ? <p className="text-sm text-slate-900">{text.name}: {proposal.changes.name}</p> : null}{proposal.changes.content ? <div><p className="text-sm font-semibold text-slate-900">{text.content}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-700">{proposal.changes.content}</p></div> : null}{proposal.changes.structuredData && Object.keys(proposal.changes.structuredData).length ? <p className="text-sm leading-6 text-stone-700">{structuredKnowledgeSummary(proposal.changes.structuredData, language)}</p> : null}</div>;

  async function decide(action: "proposal-edit" | "proposal-accept" | "proposal-reject" | "proposal-defer") {
    if (!reason.trim()) { setValidation(text.reasonRequired); return; }
    if (action === "proposal-edit" && !valid) { setValidation(text.invalidFields); return; }
    setValidation("");
    await onAction({ action, proposalId: proposal.id, proposalRevision: proposal.revision, reason: reason.trim(), ...(action === "proposal-edit" ? { changes: { name: name.trim(), content, structuredData } } : {}) }, action === "proposal-edit" ? text.saved : action === "proposal-accept" ? text.accepted : action === "proposal-reject" ? text.rejected : text.deferred);
  }

  return <div className="mt-4 space-y-4 border-t border-stone-200 pt-4">
    <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">{text.draftHint}</p>
    {!stale && source?.version ? <section aria-labelledby={`${fieldId}-comparison`} className="min-w-0 space-y-3" data-testid="knowledge-proposal-comparison">
      <h4 className="text-sm font-semibold text-slate-900" id={`${fieldId}-comparison`}>{text.comparison}</h4>
      {differences.length ? <div className="max-w-full overflow-x-auto rounded-lg border border-stone-200" tabIndex={0}><table className="w-full table-fixed border-collapse text-left text-sm"><caption className="sr-only">{text.comparison}</caption><thead><tr><th className="w-1/5 border-b border-stone-200 p-2">{text.field}</th><th className="w-2/5 border-b border-stone-200 p-2">{text.currentContent}</th><th className="w-2/5 border-b border-stone-200 p-2">{text.proposedContent}</th></tr></thead><tbody>{differences.map((difference) => <tr key={difference.field}><th scope="row" className="break-words border-b border-stone-200 p-2 align-top font-medium">{comparisonField(difference.field)}</th><td className="border-b border-stone-200 bg-amber-50/60 p-2 align-top"><div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words" tabIndex={0}>{difference.before || "—"}</div></td><td className="border-b border-stone-200 bg-emerald-50/60 p-2 align-top"><div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words" tabIndex={0}>{difference.after || "—"}</div></td></tr>)}</tbody></table></div> : <p className="text-sm text-stone-600">{text.noDifferences}</p>}
    </section> : null}
    <fieldset className="space-y-4" disabled={disabled || !active}>
      <Field label={text.name}><input className={inputClass} disabled={stale} maxLength={200} onChange={(event) => setName(event.target.value)} value={name} /></Field>
      <Field label={text.content}><textarea className={inputClass} disabled={stale} maxLength={150000} onChange={(event) => setContent(event.target.value)} rows={7} value={content} /></Field>
      <fieldset className="space-y-3" disabled={stale}><legend className="mb-2 text-sm font-semibold text-slate-900">{text.structuredFields}</legend>
        {rows.map((row, index) => <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]" key={row.id}>
          <Field label={`${text.field} ${index + 1}`}><input className={inputClass} maxLength={160} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))} value={row.key} /></Field>
          <Field label={knowledgeFieldLabel(row.key, language) || text.value}><input className={inputClass} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} value={row.value} /></Field>
          <button aria-label={`${text.removeField}: ${knowledgeFieldLabel(row.key, language) || index + 1}`} className={`${buttonClass} self-end`} onClick={() => { setRows((current) => current.filter((item) => item.id !== row.id)); if (row.originalKey) setRemovedKeys((current) => [...current, row.originalKey!]); }} type="button">×</button>
        </div>)}
        <button className={buttonClass} disabled={rows.length >= 50} onClick={() => setRows((current) => [...current, { id: `${fieldId}:${Date.now()}`, key: "", value: "", custom: true }])} type="button">{text.addField}</button>
      </fieldset>
      <Field label={text.reason}><textarea className={inputClass} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder={text.reasonHint} rows={2} value={reason} /></Field>
      {validation ? <p className="text-sm text-red-800" role="alert">{validation}</p> : null}
      {dirty ? <p className="text-sm text-amber-900">{text.unsavedHint}</p> : null}
      <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={stale || !dirty || !name.trim()} onClick={() => void decide("proposal-edit")} type="button">{text.saveProposal}</button><button className={primaryClass} disabled={stale || dirty} onClick={() => void decide("proposal-accept")} type="button">{text.accept}</button><button className={buttonClass} onClick={() => void decide("proposal-defer")} type="button">{text.defer}</button><button className={`${buttonClass} text-red-800`} onClick={() => void decide("proposal-reject")} type="button">{text.reject}</button></div>
    </fieldset>
  </div>;
}

function defaultConfiguration(area: KnowledgeArea): Configuration {
  const fields: ReviewField[] = area.kind !== "project" ? [
    { fieldPath: "companyName", required: true, sourceTypes: ["structured"] },
    { fieldPath: "description", required: true, sourceTypes: ["structured"] },
  ] : [
    { fieldPath: "projectName", sourceTypes: ["structured"] },
    { fieldPath: "description", required: true, sourceTypes: ["structured"] },
    { fieldPath: "priceInformation", required: true, sourceTypes: ["structured"], sensitivity: "price" },
    { fieldPath: "availabilityInformation", required: true, sourceTypes: ["structured"], sensitivity: "availability" },
  ];
  return { areaId: area.id, fields, staleAfterDays: 90, enabled: false, updatedBy: null, updatedAt: null, isDefault: true };
}

function ConfigurationEditor({ configuration, text, disabled, onAction }: { configuration: Configuration; text: Copy; disabled: boolean; onAction: Action }) {
  const [fields, setFields] = useState<ReviewField[]>(configuration.fields);
  const [days, setDays] = useState(String(configuration.staleAfterDays));
  const [reason, setReason] = useState("");
  const [enabled, setEnabled] = useState(configuration.enabled ?? false);
  const [validation, setValidation] = useState("");
  const rowId = useId();
  const [rowIds, setRowIds] = useState(() => configuration.fields.map((_, index) => `${rowId}:${index}`));
  function change(index: number, changes: Partial<ReviewField>) { setFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...changes } : field)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) { setValidation(text.reasonRequired); return; }
    const paths = fields.map((field) => field.fieldPath.trim());
    if (paths.some((path) => !path) || new Set(paths).size !== paths.length) { setValidation(text.invalidFields); return; }
    setValidation("");
    await onAction({ action: "configure", areaId: configuration.areaId, fields: fields.map((field) => ({ ...field, fieldPath: field.fieldPath.trim() })), staleAfterDays: Number(days), enabled, reason: reason.trim() }, text.configured);
  }
  return <form className="space-y-4" onSubmit={(event) => void submit(event)}><fieldset className="space-y-4" disabled={disabled}>
    <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800"><input checked={enabled} className="h-4 w-4 accent-emerald-800" onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />{text.automaticChecks}</label>
    <p className="text-sm leading-6 text-stone-600">{text.automaticChecksHint}</p>
    <div className="max-w-sm"><Field label={text.staleDays}><input className={inputClass} max={36500} min={1} onChange={(event) => setDays(event.target.value)} required type="number" value={days} /></Field></div>
    <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold text-slate-900">{text.ruleFields}</legend>{fields.map((field, index) => <div className="space-y-3 rounded-xl border border-stone-200 p-3" key={rowIds[index]}>
      <div className="grid gap-3 md:grid-cols-3"><Field label={text.ruleKey}><input className={inputClass} maxLength={160} onChange={(event) => change(index, { fieldPath: event.target.value })} required value={field.fieldPath} /></Field><Field label={text.sensitivity}><select className={inputClass} onChange={(event) => change(index, { sensitivity: event.target.value as ReviewField["sensitivity"] })} value={field.sensitivity ?? "general"}>{(["general", "price", "availability", "payment", "legal"] as const).map((value) => <option key={value} value={value}>{text[value]}</option>)}</select></Field><Field label={text.compareAs}><select className={inputClass} onChange={(event) => change(index, { compareAs: event.target.value as ReviewField["compareAs"] })} value={field.compareAs ?? "text"}>{(["text", "number", "boolean"] as const).map((value) => <option key={value} value={value}>{text[value]}</option>)}</select></Field></div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800"><input checked={field.required ?? false} className="h-4 w-4 accent-emerald-800" onChange={(event) => change(index, { required: event.target.checked })} type="checkbox" />{text.required}</label>
      <fieldset><legend className="text-sm font-medium text-slate-800">{text.sourceTypes}</legend><div className="flex flex-wrap gap-x-4">{sourceTypes.map((type) => <label className="flex min-h-11 items-center gap-2 text-sm text-stone-700" key={type}><input checked={!field.sourceTypes || field.sourceTypes.includes(type)} className="h-4 w-4 accent-emerald-800" onChange={(event) => { const selected = field.sourceTypes ?? sourceTypes; change(index, { sourceTypes: event.target.checked ? [...selected, type] : selected.filter((value) => value !== type) }); }} type="checkbox" />{text[type]}</label>)}</div></fieldset>
      <button aria-label={`${text.removeRule}: ${field.fieldPath || index + 1}`} className={buttonClass} onClick={() => { setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index)); setRowIds((current) => current.filter((_, fieldIndex) => fieldIndex !== index)); }} type="button">{text.removeRule}</button>
    </div>)}<button className={buttonClass} disabled={fields.length >= 50} onClick={() => { setFields((current) => [...current, { fieldPath: "", sensitivity: "general", compareAs: "text" }]); setRowIds((current) => [...current, `${rowId}:${Date.now()}`]); }} type="button">{text.addRule}</button></fieldset>
    <Field label={text.configReason}><textarea className={inputClass} maxLength={2000} onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} /></Field>
    {validation ? <p className="text-sm text-red-800" role="alert">{validation}</p> : null}<button className={primaryClass} type="submit">{text.saveConfig}</button>
  </fieldset></form>;
}

export function KnowledgeMaintenancePanel({ snapshot, language, scopedPath, onChanged }: { snapshot: KnowledgeCenterSnapshot; language: LanguageCode; scopedPath: (path: string) => string; onChanged: () => Promise<void> }) {
  const text = getKnowledgeMaintenanceCopy(language);
  const [data, setData] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"proposals" | "activity" | "configuration">("proposals");
  const [areaId, setAreaId] = useState("");
  const [status, setStatus] = useState<ProposalStatus | "">("");
  const [selectedId, setSelectedId] = useState("");
  const [configurationAreaId, setConfigurationAreaId] = useState(snapshot.areas.find((area) => !area.archivedAt)?.id ?? "");
  const tabId = useId();
  const activeAreas = snapshot.areas.filter((area) => !area.archivedAt);
  const canWrite = snapshot.permissions.canWrite && snapshot.entitlement.enabled && snapshot.available;
  const canConfigure = snapshot.permissions.canPublish && snapshot.entitlement.enabled && snapshot.available;
  const hasMaintenance = snapshot.entitlement.features.advancedMaintenance;

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await csrfFetch(scopedPath("/api/knowledge-center/workflow"), { cache: "no-store", signal });
    const payload = await response.json().catch(() => null) as (Workflow & { error?: string }) | null;
    if (!response.ok || !payload || !Array.isArray(payload.proposals) || !Array.isArray(payload.events) || !Array.isArray(payload.configurations)) throw new Error(payload?.error || text.loadError);
    return payload;
  }, [scopedPath, text.loadError]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then((payload) => { if (!controller.signal.aborted) setData(payload); }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text.loadError); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, text.loadError]);

  async function refresh() {
    setLoading(true); setError("");
    try { setData(await load()); } catch (cause) { setError(cause instanceof Error ? cause.message : text.loadError); } finally { setLoading(false); }
  }

  const runAction: Action = async (body, success) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await csrfFetch(scopedPath("/api/knowledge-center/workflow"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok || !result) throw new Error(result?.error || text.saveError);
      const [payload] = await Promise.all([load(), onChanged()]);
      setData(payload); setNotice(success); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : text.saveError); return false; } finally { setBusy(false); }
  };

  const proposals = useMemo(() => (data?.proposals ?? []).filter((proposal) => (!status || proposal.status === status) && (!areaId || proposal.areaId === areaId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [data, status, areaId]);
  const events = useMemo(() => [...(data?.events ?? [])].filter((event) => !areaId || eventAreas(event, snapshot).includes(areaId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [data, areaId, snapshot]);
  const configurationArea = activeAreas.find((area) => area.id === configurationAreaId) ?? activeAreas[0];
  const configuration = configurationArea ? data?.configurations.find((item) => item.areaId === configurationArea.id) ?? defaultConfiguration(configurationArea) : null;

  return <section aria-label={text.title} className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold text-slate-950">{text.title}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">{text.description}</p></div><button className={buttonClass} disabled={busy || loading} onClick={() => void refresh()} type="button">{text.refresh}</button></div>
    {!canWrite ? <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700">{text.readOnly}</p> : null}
    {!hasMaintenance ? <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700">{text.advancedUnavailable}</p> : null}
    {error ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p> : null}
    {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" role="status">{notice}</p> : null}
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={text.title}>{(["proposals", "activity", "configuration"] as const).map((value, index, tabs) => <button aria-controls={`${tabId}-panel-${value}`} aria-selected={tab === value} className={`${buttonClass} ${tab === value ? "border-emerald-800 bg-emerald-50 text-emerald-950" : ""}`} id={`${tabId}-tab-${value}`} key={value} onClick={() => setTab(value)} onKeyDown={(event) => { const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null; if (next === null) return; event.preventDefault(); setTab(tabs[next]); document.getElementById(`${tabId}-tab-${tabs[next]}`)?.focus(); }} role="tab" tabIndex={tab === value ? 0 : -1} type="button">{text[value]}{value === "proposals" && data ? ` (${data.proposals.filter((proposal) => proposal.status === "open").length})` : ""}</button>)}</div>
    {loading && !data ? <p className="py-6 text-sm text-stone-600" role="status">{text.loading}</p> : null}
    {tab === "proposals" ? <div aria-labelledby={`${tabId}-tab-proposals`} className="space-y-4" id={`${tabId}-panel-proposals`} role="tabpanel">
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-52 flex-1"><Field label={text.area}><select className={inputClass} onChange={(event) => setAreaId(event.target.value)} value={areaId}><option value="">{text.allAreas}</option>{activeAreas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field></div><div className="min-w-44"><Field label={text.status}><select className={inputClass} onChange={(event) => setStatus(event.target.value as ProposalStatus | "")} value={status}><option value="">{text.allStatuses}</option>{(["open", "deferred", "accepted", "rejected"] as const).map((value) => <option key={value} value={value}>{statusTitle(value, text)}</option>)}</select></Field></div><button className={primaryClass} disabled={!canWrite || !hasMaintenance || busy || loading || !activeAreas.length} onClick={() => void runAction({ action: "analyze", ...(areaId ? { areaId } : {}) }, text.analyzed)} type="button">{busy ? text.analyzing : text.analyze}</button></div>
      {data && !proposals.length ? <EmptyState description={!data.proposals.length ? text.noProposalsHint : undefined} title={data.proposals.length ? text.noMatching : text.noProposals} /> : null}
      <div className="space-y-3">{proposals.map((proposal) => {
        const source = snapshot.sources.find((item) => item.id === proposal.sourceId);
        const active = proposal.status === "open" || proposal.status === "deferred";
        const stale = active && (!source || source.revision !== proposal.sourceRevision || proposal.references.some((reference) => { const current = snapshot.sources.find((item) => item.id === reference.sourceId); return !current || current.revision !== reference.sourceRevision || current.version?.id !== reference.versionId; }));
        const assistants = assignedAssistants(snapshot, [...new Set([proposal.areaId, ...proposal.references.map((reference) => reference.areaId)])]);
        const expanded = selectedId === proposal.id;
        return <article className="rounded-xl border border-stone-200 bg-white p-4" key={proposal.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-950">{proposalTitle(proposal.kind, text)}</h3><span className={`rounded-md px-2 py-1 text-xs font-semibold ${proposal.status === "accepted" ? "bg-emerald-50 text-emerald-900" : proposal.status === "rejected" ? "bg-stone-100 text-stone-700" : "bg-amber-50 text-amber-900"}`}>{statusTitle(proposal.status, text)}</span>{stale ? <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-950">{text.stale}</span> : null}</div><p className="mt-2 text-sm text-stone-700">{text.source}: {source?.name ?? text.unavailableSource}</p><p className="mt-1 text-xs text-stone-500">{text.created}: {formatDate(proposal.createdAt, language)} · {text.updated}: {formatDate(proposal.updatedAt, language)}</p></div><button aria-controls={`${tabId}-proposal-${proposal.id}`} aria-expanded={expanded} className={buttonClass} onClick={() => setSelectedId(expanded ? "" : proposal.id)} type="button">{expanded ? text.close : text.review}</button></div>
          <p className="mt-3 text-sm font-medium text-slate-800">{proposal.approvalLevel >= 3 ? text.adminReview : proposal.approvalLevel === 2 ? text.customerReview : text.internalReview}</p><p className="mt-1 text-sm text-stone-600">{text.affectedAssistants}: {assistants.length ? assistants.join(" · ") : text.noAssistants}</p>
          <div className="mt-3"><ProposalEvidence language={language} proposal={proposal} text={text} /></div>
          {expanded ? <div className="mt-3 space-y-1 text-sm text-stone-600"><p><span className="font-medium text-slate-800">{text.sourceVersion}: </span>{proposal.references.map((reference) => `${snapshot.sources.find((item) => item.id === reference.sourceId)?.name ?? text.unavailableSource} (${text.version} ${reference.contentVersion})`).join(" · ")}</p>{proposal.reason ? <p className="whitespace-pre-wrap leading-6"><span className="font-medium text-slate-800">{text.reason}: </span>{proposal.reason}</p> : null}</div> : null}
          {expanded ? <div id={`${tabId}-proposal-${proposal.id}`}>{stale ? <p className="mt-3 text-sm leading-6 text-amber-950">{text.staleHint}</p> : null}<ProposalEditor disabled={!canWrite || busy} key={`${proposal.id}:${proposal.revision}`} language={language} onAction={runAction} proposal={proposal} source={source} stale={stale} text={text} /></div> : null}
        </article>;
      })}</div>
    </div> : null}
    {tab === "activity" ? <div aria-labelledby={`${tabId}-tab-activity`} className="space-y-4" id={`${tabId}-panel-activity`} role="tabpanel"><div className="max-w-md"><Field label={text.area}><select className={inputClass} onChange={(event) => setAreaId(event.target.value)} value={areaId}><option value="">{text.allAreas}</option>{activeAreas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field></div>{data && !events.length ? <EmptyState description={text.noEventsHint} title={text.noEvents} /> : null}<ol className="space-y-3">{events.map((event) => {
      const source = snapshot.sources.find((item) => item.id === event.sourceId);
      const assistants = assignedAssistants(snapshot, eventAreas(event, snapshot), stringArray(event.details.affectedAssistantIds));
      return <li className="rounded-xl border border-stone-200 bg-white p-4" key={event.id}><p className="font-semibold text-slate-900">{eventTitle(event, text)}</p><p className="mt-1 text-sm text-stone-600"><time dateTime={event.createdAt}>{formatDate(event.createdAt, language)}</time> · {text.actor}: {event.actorName || (event.actorId ? text.teamMember : text.system)}</p>{source ? <p className="mt-2 text-sm text-stone-700">{text.source}: {source.name}</p> : null}<p className="mt-1 text-sm text-stone-700">{text.affectedAssistants}: {assistants.length ? assistants.join(" · ") : text.noAssistants}</p>{typeof event.details.reason === "string" ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-600">{event.details.reason}</p> : null}</li>;
    })}</ol></div> : null}
    {tab === "configuration" ? <div aria-labelledby={`${tabId}-tab-configuration`} className="space-y-4" id={`${tabId}-panel-configuration`} role="tabpanel"><p className="text-sm leading-6 text-stone-600">{text.configDescription}</p>{!canConfigure ? <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700">{text.administratorOnly}</p> : null}{configurationArea && configuration ? <><div className="max-w-md"><Field label={text.area}><select className={inputClass} disabled={busy} onChange={(event) => setConfigurationAreaId(event.target.value)} value={configurationArea.id}>{activeAreas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field></div>{data ? <ConfigurationEditor configuration={configuration} disabled={!canConfigure || !hasMaintenance || busy} key={`${configuration.areaId}:${JSON.stringify(configuration)}`} onAction={runAction} text={text} /> : null}</> : <EmptyState title={text.noAreas} />}</div> : null}
  </section>;
}
