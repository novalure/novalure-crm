"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { LanguageCode } from "@/lib/i18n";
import { displayTimeZone } from "@/lib/i18n";
import { getKnowledgeLifecycleCopy } from "@/lib/knowledge-center/lifecycle-copy";
import { getKnowledgeCenterCopy, getKnowledgeErrorMessage } from "@/lib/knowledge-center/copy";
import { knowledgeFieldLabel, structuredKnowledgeSummary } from "@/lib/knowledge-center/templates";
import { compareKnowledgeVersions } from "@/lib/knowledge-center/version-comparison";
import type { KnowledgeCenterSnapshot, KnowledgeSource, KnowledgeVersion } from "@/lib/knowledge-center/types";
import { csrfFetch } from "@/lib/security/csrf-client";

const inputClass = "evelyn-domain-input min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:bg-stone-100";
const buttonClass = "evelyn-domain-button min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} evelyn-domain-button-primary border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900`;
type Version = KnowledgeVersion & { createdByName?: string | null };
type Workflow = { state: string; versionId: string; submittedBy?: string; reviewedBy?: string; approvedBy?: string };
type WorkflowDetails = { source?: KnowledgeSource; versions: Version[]; workflow: Workflow | null };
type Props = { source: KnowledgeSource; snapshot: KnowledgeCenterSnapshot; language: LanguageCode; scopedPath: (path: string) => string; onChanged: () => Promise<void>; showHistory?: boolean };

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(typeof body?.code === "string" ? body.code : fallback);
  return body as T;
}

export function KnowledgeLifecyclePanel({ source, snapshot, language, scopedPath, onChanged, showHistory = false }: Props) {
  const text = getKnowledgeLifecycleCopy(language);
  const id = useId();
  const [details, setDetails] = useState<WorkflowDetails | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [currentConfirmed, setCurrentConfirmed] = useState(false);
  const [legalConfirmed, setLegalConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const endpoint = snapshot.permissions.canWrite ? "workflow" : "versions";
    const response = await csrfFetch(scopedPath(`/api/knowledge-center/${endpoint}?${new URLSearchParams({ sourceId: source.id })}`), { cache: "no-store", signal });
    const payload = await readResponse<WorkflowDetails>(response, text.loadError);
    return { ...payload, workflow: payload.workflow ?? null };
  }, [scopedPath, source.id, snapshot.permissions.canWrite, text.loadError]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then((data) => {
      if (!controller.signal.aborted) { setDetails(data); setError(""); }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(getKnowledgeErrorMessage(language, cause, text.loadError));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [language, load, source.revision, text.loadError]);
  const version = source.version;
  const selected = details?.versions.find((item) => item.id === selectedId) ?? details?.versions.find((item) => item.id !== version?.id) ?? version;
  const activeWorkflow = details?.workflow && details.workflow.versionId === version?.id ? details.workflow : null;
  const state = source.archivedAt ? "archived" : activeWorkflow?.state ?? (version?.id === source.approvedVersionId ? "published" : "draft");
  const readable = Boolean(version && version.processingStatus !== "failed" && version.processingStatus !== "needs_ocr" && (version.content.trim() || Object.keys(version.structuredData).length));
  const differences = selected && version ? compareKnowledgeVersions(selected, version) : [];
  const affected = snapshot.assignments.filter((assignment) => assignment.areaId === source.areaId).map((assignment) => ({ ...assignment, name: snapshot.bots.find((bot) => bot.id === assignment.botId)?.name })).filter((assignment) => assignment.name);
  const stateLabel = (value: string) => (text as Record<string, string>)[value] ?? text.error;
  const date = (value: string) => Number.isNaN(new Date(value).getTime()) ? text.none : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone }).format(new Date(value));
  const originLabel = (item: Version) => item.provenance?.kind === "restoration" ? text.restoredOrigin : item.provenance?.kind === "proposal" ? text.proposalOrigin : item.provenance?.kind === "revocation" ? text.revokedOrigin : source.type === "file" ? text.documentOrigin : source.type === "url" ? text.websiteOrigin : text.manualOrigin;
  const fieldLabel = (value: string) => value === "name" ? text.title : value === "content" ? text.content : value === "url" ? text.website : value === "mediaAssetId" ? text.document : knowledgeFieldLabel(value.replace(/^structured\./, ""), language);
  const canWrite = snapshot.permissions.canWrite && snapshot.entitlement.enabled;
  const canPublish = snapshot.permissions.canPublish && snapshot.entitlement.enabled;
  const transitions = [
    { action: "submit", label: text.submit, allowed: canWrite && ["draft", "revoked"].includes(state) },
    { action: "review", label: text.review, allowed: canPublish && state === "submitted" },
    { action: "approve", label: text.approve, allowed: canPublish && state === "reviewed" },
    { action: "publish", label: text.publish, allowed: canPublish && state === "approved" },
    { action: "revoke", label: text.revoke, allowed: canPublish && Boolean(source.approvedVersionId) },
  ];
  async function mutate(action: string, targetVersion = version?.id) {
    setBusy(action); setError(""); setNotice("");
    try {
      const restore = action === "restore";
      const response = await csrfFetch(scopedPath("/api/knowledge-center/workflow"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sourceId: source.id, versionId: action === "revoke" ? source.approvedVersionId : targetVersion, expectedVersion: source.revision, reason: restore ? restoreReason.trim() : reason.trim(), ...(restore ? { confirmCurrentness: currentConfirmed, confirmLegal: legalConfirmed } : {}) }),
      });
      await readResponse(response, text.saveError);
      await onChanged();
      setDetails(await load());
      setReason(""); setRestoreReason(""); setReviewConfirmed(false); setCurrentConfirmed(false); setLegalConfirmed(false); setNotice(text.saved);
    } catch (cause) { setError(getKnowledgeErrorMessage(language, cause, text.saveError)); }
    finally { setBusy(""); }
  }
  return <section aria-labelledby={`${id}-title`} className="evelyn-knowledge-review mt-4 grid min-w-0 gap-4 rounded-xl border border-emerald-200 bg-stone-50 p-4" data-testid="knowledge-lifecycle">
    <div className="flex flex-wrap items-center justify-between gap-2"><h6 className="font-semibold text-slate-950" id={`${id}-title`}>{text.lifecycle}</h6><span className="rounded-md bg-white px-2 py-1 text-xs font-semibold">{stateLabel(state)}</span></div>
    {loading ? <p role="status">{text.loading}</p> : null}
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"><p>{error}</p><button className={`${buttonClass} mt-2`} type="button" disabled={Boolean(busy)} onClick={() => { setLoading(true); void load().then((data) => { setDetails(data); setError(""); }).catch((cause: unknown) => setError(getKnowledgeErrorMessage(language, cause, text.loadError))).finally(() => setLoading(false)); }}>{text.retry}</button></div> : null}
    {notice ? <p aria-live="polite" role="status" className="text-sm font-medium text-emerald-900">{notice}</p> : null}
    <p className="text-xs leading-5 text-stone-600">{text.statusHint}</p>
    {version ? <div className="grid gap-2"><p className="text-sm font-medium">{text.content} · {text.version} {version.version}</p><div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-4 text-sm leading-6 text-slate-800" tabIndex={0}>{version.content || structuredKnowledgeSummary(version.structuredData, language) || text.noContent}</div></div> : null}
    <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm"><p className="font-medium">{text.currentUse}: {source.approvedVersionId ? details?.versions.find((item) => item.id === source.approvedVersionId)?.version ?? text.none : text.none}</p><p className="mt-1 text-xs leading-5 text-stone-600">{source.approvedVersionId && !activeWorkflow && version?.status === "approved" ? text.legacyPublished : text.publicationHint}</p><p className="mt-2 font-medium">{text.affected}</p><p className="mt-1 text-xs leading-5 text-stone-600">{affected.length ? affected.map((assignment) => `${assignment.name} (${getKnowledgeCenterCopy(language)[assignment.channel === "telephone" ? "voice" : assignment.channel]})`).join(", ") : text.noAffected}</p></div>
    {!loading && details && !source.archivedAt && transitions.some((item) => item.allowed) ? <form className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
      <label className="grid gap-1.5 text-sm font-medium" htmlFor={`${id}-reason`}>{text.reason}<textarea className={inputClass} id={`${id}-reason`} maxLength={2000} required value={reason} disabled={Boolean(busy)} onChange={(event) => setReason(event.target.value)} /><span className="text-xs font-normal text-stone-600">{text.reasonHint}</span></label>
      {["submitted", "reviewed", "approved"].includes(state) ? <label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1 h-5 w-5 shrink-0 accent-emerald-800" type="checkbox" checked={reviewConfirmed} disabled={Boolean(busy)} onChange={(event) => setReviewConfirmed(event.target.checked)} /><span>{text.reviewConfirm}</span></label> : null}
      <div className="flex flex-wrap gap-2">{transitions.filter((item) => item.allowed).map((item) => <button className={item.action === "revoke" ? buttonClass : primaryClass} type="button" key={item.action} disabled={Boolean(busy) || !reason.trim() || (!readable && item.action !== "revoke") || (["review", "approve", "publish"].includes(item.action) && !reviewConfirmed)} onClick={() => void mutate(item.action)} data-testid={`knowledge-${item.action}`}>{busy === item.action ? text.saving : item.label}</button>)}</div>
      {!readable ? <p className="text-sm text-amber-950">{text.noContent}</p> : null}
    </form> : null}
    <details open={showHistory || undefined} className="evelyn-knowledge-history min-w-0 rounded-lg border border-stone-200 bg-white p-3" data-testid="knowledge-version-history">
      <summary className="min-h-8 cursor-pointer font-semibold text-slate-950">{text.history}</summary>
      {details?.versions.length ? <div className="mt-3 grid min-w-0 gap-4">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor={`${id}-version`}>{text.version}<select className={inputClass} id={`${id}-version`} value={selected?.id ?? ""} onChange={(event) => { setSelectedId(event.target.value); setCurrentConfirmed(false); setLegalConfirmed(false); setRestoreReason(""); }}>{details.versions.map((item) => <option key={item.id} value={item.id}>{text.version} {item.version} · {date(item.createdAt)}{item.id === source.approvedVersionId ? ` · ${text.currentUse}` : item.id !== source.draftVersionId ? ` · ${text.archived}` : ""}</option>)}</select></label>
        {selected ? <><dl className="grid gap-2 text-xs text-stone-600 sm:grid-cols-2"><div><dt className="font-semibold">{text.date}</dt><dd>{date(selected.createdAt)}</dd></div><div><dt className="font-semibold">{text.origin}</dt><dd>{originLabel(selected)}</dd></div>{selected.createdBy ? <div><dt className="font-semibold">{text.actor}</dt><dd className="break-words">{selected.createdByName || text.none}</dd></div> : null}{selected.changeReason ? <div><dt className="font-semibold">{text.changeReason}</dt><dd className="break-words">{selected.changeReason}</dd></div> : null}</dl>
          {selected.mediaAssetId ? <div><a className={buttonClass} href={scopedPath(`/api/knowledge-center/sources/${encodeURIComponent(source.id)}/document?${new URLSearchParams({ versionId: selected.id })}`)} rel="noopener noreferrer" target="_blank">{getKnowledgeCenterCopy(language).documentOpen}</a></div> : null}
          <h6 className="text-sm font-semibold">{text.comparison}</h6>
          {differences.length ? <div className="min-w-0 overflow-x-auto" tabIndex={0}><table className="w-full table-fixed border-collapse text-left text-sm"><caption className="sr-only">{text.comparison}</caption><thead><tr><th className="w-1/5 border-b border-stone-200 p-2">{text.field}</th><th className="w-2/5 border-b border-stone-200 p-2">{text.before}</th><th className="w-2/5 border-b border-stone-200 p-2">{text.after}</th></tr></thead><tbody>{differences.map((difference) => <tr key={difference.field}><th scope="row" className="break-words border-b border-stone-200 p-2 align-top font-medium">{fieldLabel(difference.field)}</th><td className="whitespace-pre-wrap break-words border-b border-stone-200 bg-amber-50/60 p-2 align-top"><div className="max-h-64 overflow-y-auto">{difference.before || text.none}</div></td><td className="whitespace-pre-wrap break-words border-b border-stone-200 bg-emerald-50/60 p-2 align-top"><div className="max-h-64 overflow-y-auto">{difference.after || text.none}</div></td></tr>)}</tbody></table></div> : <p className="text-sm text-stone-600">{text.noDifferences}</p>}
          {canWrite && !source.archivedAt && selected.id !== version?.id ? <div className="grid gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3"><p className="text-xs leading-5 text-stone-600">{text.restoreHint}</p><label className="grid gap-1.5 text-sm font-medium" htmlFor={`${id}-restore-reason`}>{text.reason}<textarea className={inputClass} id={`${id}-restore-reason`} required maxLength={2000} value={restoreReason} onChange={(event) => setRestoreReason(event.target.value)} disabled={Boolean(busy)} /></label><label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1 h-5 w-5 shrink-0 accent-emerald-800" type="checkbox" checked={currentConfirmed} onChange={(event) => setCurrentConfirmed(event.target.checked)} disabled={Boolean(busy)} /><span>{text.currentConfirm}</span></label><label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1 h-5 w-5 shrink-0 accent-emerald-800" type="checkbox" checked={legalConfirmed} onChange={(event) => setLegalConfirmed(event.target.checked)} disabled={Boolean(busy)} /><span>{text.legalConfirm}</span></label><div><button className={buttonClass} type="button" data-testid="knowledge-restore" disabled={Boolean(busy) || !restoreReason.trim() || !currentConfirmed || !legalConfirmed} onClick={() => void mutate("restore", selected.id)}>{busy === "restore" ? text.saving : text.restore}</button></div></div> : null}
        </> : null}
      </div> : !loading ? <p className="mt-3 text-sm text-stone-600">{text.noVersions}</p> : null}
    </details>
  </section>;
}
