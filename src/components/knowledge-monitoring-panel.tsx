"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { displayTimeZone, type LanguageCode } from "@/lib/i18n";
import { getKnowledgeLifecycleCopy, knowledgeMonitoringError } from "@/lib/knowledge-center/lifecycle-copy";
import type { KnowledgeCenterSnapshot, KnowledgeSource } from "@/lib/knowledge-center/types";
import { csrfFetch } from "@/lib/security/csrf-client";

const inputClass = "evelyn-domain-input min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:bg-stone-100";
const buttonClass = "evelyn-domain-button min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
type Interval = "manual" | "daily" | "weekly" | "monthly";
type Run = { id: string; trigger: string; status: string; attempts: number; startedAt: string; completedAt: string | null; errorCode: string | null; proposalId: string | null };
type Details = { config: { interval: Interval; enabled: boolean; revision: number; nextDueAt: string | null; lastSuccessAt: string | null; lastScanAt: string | null; lastErrorCode: string | null; lastRunStatus: string | null } | null; history: Run[]; scansThisMonth: number; allowedIntervals: Interval[] };
type Props = { source: KnowledgeSource; snapshot: KnowledgeCenterSnapshot; language: LanguageCode; scopedPath: (path: string) => string; onChanged: () => Promise<void> };
async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || fallback);
  return body as T;
}

export function KnowledgeMonitoringPanel({ source, snapshot, language, scopedPath, onChanged }: Props) {
  const id = useId();
  const text = getKnowledgeLifecycleCopy(language);
  const [details, setDetails] = useState<Details | null>(null);
  const [interval, setInterval] = useState<Interval>("manual");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await csrfFetch(scopedPath(`/api/knowledge-center/monitoring?${new URLSearchParams({ sourceId: source.id })}`), { cache: "no-store", signal });
    const payload = await readResponse<Details>(response, text.loadError);
    return payload;
  }, [scopedPath, source.id, text.loadError]);
  const setLoaded = useCallback((payload: Details) => {
    setDetails(payload); setInterval(payload.config?.interval ?? "manual"); setEnabled(payload.config?.enabled ?? false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then((payload) => { if (!controller.signal.aborted) { setLoaded(payload); setError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text.loadError); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, setLoaded, source.revision, text.loadError]);
  const date = (value?: string | null, fallback = text.never) => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone }).format(new Date(value)) : fallback;
  const canWrite = snapshot.entitlement.enabled && snapshot.permissions.canWrite && snapshot.entitlement.features.websiteImport && !source.archivedAt;
  const allowedIntervals = details?.allowedIntervals ?? ["manual"];
  const stateLabel = (value: string) => (text as Record<string, string>)[value] ?? text.failed;
  async function act(action: "save" | "scan") {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await csrfFetch(scopedPath(action === "save" ? "/api/knowledge-center/monitoring" : "/api/knowledge-center/scans"), {
        method: action === "save" ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, expectedVersion: source.revision, ...(action === "save" ? { interval, enabled: interval !== "manual" && enabled } : {}) }),
      });
      await readResponse(response, text.saveError);
      await onChanged();
      setLoaded(await load());
      setNotice(action === "scan" ? text.scanSaved : text.saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : text.saveError); }
    finally { setBusy(""); }
  }
  return <section aria-labelledby={`${id}-heading`} className="evelyn-knowledge-review mt-4 grid min-w-0 gap-4 rounded-xl border border-stone-200 bg-stone-50 p-4" data-testid="knowledge-monitoring">
    <h6 className="font-semibold text-slate-950" id={`${id}-heading`}>{text.monitoring}</h6>
    <p className="text-xs leading-5 text-stone-600">{text.monitoringHint}</p>
    {loading ? <p role="status" className="text-sm text-stone-600">{text.loading}</p> : null}
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"><p>{error}</p><button type="button" className={`${buttonClass} mt-2`} disabled={Boolean(busy)} onClick={() => { setLoading(true); void load().then((payload) => { setLoaded(payload); setError(""); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : text.loadError)).finally(() => setLoading(false)); }}>{text.retry}</button></div> : null}
    {notice ? <p role="status" aria-live="polite" className="text-sm font-medium text-emerald-900">{notice}</p> : null}
    {details ? <>
      <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-semibold text-slate-900">{text.nextDue}</dt><dd className="mt-1 text-stone-600">{date(details.config?.nextDueAt, text.notScheduled)}</dd></div><div><dt className="font-semibold text-slate-900">{text.lastScan}</dt><dd className="mt-1 text-stone-600">{date(details.config?.lastScanAt)}{details.config?.lastRunStatus ? ` · ${stateLabel(details.config.lastRunStatus)}` : ""}</dd></div><div><dt className="font-semibold text-slate-900">{text.lastSuccess}</dt><dd className="mt-1 text-stone-600">{date(details.config?.lastSuccessAt)}</dd></div><div><dt className="font-semibold text-slate-900">{text.consumption}</dt><dd className="mt-1 text-stone-600">{new Intl.NumberFormat(language).format(details.scansThisMonth)} / {new Intl.NumberFormat(language).format(snapshot.entitlement.limits.maxScansPerMonth)}</dd></div>{details.config?.lastErrorCode ? <div className="rounded-lg bg-amber-50 p-2 text-amber-950"><dt className="font-semibold">{text.lastError}</dt><dd className="mt-1">{knowledgeMonitoringError(language, details.config.lastErrorCode)}</dd></div> : null}</dl>
      <form onSubmit={(event) => { event.preventDefault(); void act("save"); }} className="grid gap-3">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor={`${id}-interval`}>{text.interval}<select className={inputClass} id={`${id}-interval`} data-testid="knowledge-monitoring-interval" disabled={Boolean(busy) || !canWrite} value={interval} onChange={(event) => { const value = event.target.value as Interval; setInterval(value); setEnabled(value !== "manual"); }}>{(["manual", "daily", "weekly", "monthly"] as const).map((value) => <option key={value} value={value} disabled={!allowedIntervals.includes(value)}>{text[value]}</option>)}</select></label>
        {allowedIntervals.length === 1 ? <p className="text-xs leading-5 text-stone-600">{text.manualOnly}</p> : null}
        <label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1 h-5 w-5 shrink-0 accent-emerald-800" type="checkbox" checked={enabled && interval !== "manual"} disabled={Boolean(busy) || !canWrite || interval === "manual"} onChange={(event) => setEnabled(event.target.checked)} /><span>{text.enabled}</span></label>
        {canWrite ? <div className="flex flex-wrap gap-2"><button className={buttonClass} type="submit" data-testid="knowledge-monitoring-save" disabled={Boolean(busy) || !allowedIntervals.includes(interval)}>{busy === "save" ? text.saving : text.save}</button><button className={buttonClass} type="button" data-testid="knowledge-monitoring-scan" disabled={Boolean(busy)} onClick={() => void act("scan")}>{busy === "scan" ? text.running : text.scan}</button></div> : null}
      </form>
      <details className="evelyn-knowledge-history rounded-lg border border-stone-200 bg-white p-3"><summary className="min-h-8 cursor-pointer text-sm font-semibold">{text.runHistory}</summary>{details.history.length ? <ol className="mt-3 grid gap-2">{details.history.map((run) => <li key={run.id} className="rounded-lg border border-stone-200 p-3 text-sm"><p className="font-medium">{stateLabel(run.status)}</p><p className="mt-1 text-xs text-stone-600">{date(run.completedAt ?? run.startedAt)} · {run.trigger === "scheduled" ? text.scheduled : text.manual}</p>{run.errorCode ? <p className="mt-1 text-xs leading-5 text-amber-950">{knowledgeMonitoringError(language, run.errorCode)}</p> : null}</li>)}</ol> : <p className="mt-3 text-sm text-stone-600">{text.noRuns}</p>}</details>
    </> : null}
  </section>;
}
