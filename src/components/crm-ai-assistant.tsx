"use client";

import { useEffect, useRef, useState } from "react";
import { ASSISTANT_MODES, type AssistantLanguage, type AssistantMode, type AssistantRequest, type AssistantResult, type AssistantSnapshot } from "@/lib/crm-ai-assistant/contracts";
import { assistantCopy } from "@/lib/crm-ai-assistant/copy";
import { csrfFetch } from "@/lib/security/csrf-client";

const cardClass = "min-w-0 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6";
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass = "inline-flex min-h-11 items-center justify-center rounded-lg border border-emerald-800 bg-emerald-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-600 focus:outline-emerald-600 disabled:bg-stone-50";
type LoadState = { context: string; state: "loading" | "ready" | "error"; snapshot: AssistantSnapshot | null };
type Operation = { context: string; key: string; body: AssistantRequest; endpoint: string; state: "sending" | "pending" | "uncertain" | "failed" | "completed"; code?: string; result?: AssistantResult };
type Envelope<T> = { persisted?: boolean; data?: T; code?: string; terminal?: boolean; error?: { code?: string } | string };

function endpointFor(workspaceId: string, language: AssistantLanguage, timeZone: string, projectId?: string | null) {
  const params = new URLSearchParams({ workspaceId, language, timeZone });
  if (projectId) params.set("projectId", projectId);
  return `/api/crm/ai-assistant?${params}`;
}

function ResultCard({ result, language }: { result: AssistantResult; language: AssistantLanguage }) {
  const text = assistantCopy[language];
  const [subject, setSubject] = useState(result.email?.subject ?? "");
  const [body, setBody] = useState(result.email?.body ?? "");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const content = result.email ? `${text.subject}: ${subject}\n\n${body}` : result.answer;
  const date = (value: string) => new Date(value).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
  async function copy() {
    try { await navigator.clipboard.writeText(content); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `crm-${result.mode}-${result.createdAt.slice(0, 10)}.txt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <article className={cardClass} aria-label={result.email ? text.emailResult : text.result} data-assistant-result>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{text.modes[result.mode].title}</p><h3 className="mt-2 text-xl font-semibold text-slate-950">{result.email ? text.emailResult : text.result}</h3></div><span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">{text.charged}: {result.chargedCredits.toLocaleString(language)} {text.credits}</span></div>
    {result.email ? <div className="mt-5 grid gap-4">
      <p className="text-sm leading-6 text-stone-600">{text.draftHint}</p>
      {result.email.recipient ? <p className="break-words text-sm text-stone-600">{text.recipient}: <span className="font-medium text-slate-800">{result.email.recipient}</span></p> : null}
      <label className="grid gap-2 text-sm font-medium text-slate-800">{text.subject}<input aria-label={text.subject} className={inputClass} value={subject} onChange={event => { setSubject(event.target.value); setCopyState("idle"); }} /></label>
      <label className="grid gap-2 text-sm font-medium text-slate-800">{text.body}<textarea aria-label={text.body} className={`${inputClass} min-h-64 resize-y leading-7`} value={body} onChange={event => { setBody(event.target.value); setCopyState("idle"); }} /></label>
    </div> : <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800" data-assistant-answer>{result.answer}</div>}
    <div className="mt-5 flex flex-wrap gap-2"><button className={buttonClass} type="button" onClick={() => void copy()}>{copyState === "copied" ? text.copied : text.copy}</button><button className={buttonClass} type="button" onClick={download}>{text.download}</button></div>
    {copyState === "failed" ? <p className="mt-3 text-sm text-amber-900" role="status">{text.copyFailed}</p> : null}
    <div className="mt-6 border-t border-stone-100 pt-4"><h4 className="text-sm font-semibold text-slate-900">{text.sources}</h4>{result.sources.length ? <ul className="mt-3 flex flex-wrap gap-2">{result.sources.map(source => <li key={`${source.type}:${source.id}`} className="max-w-full break-words rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-700"><span className="font-semibold">{text.sourceTypes[source.type]}:</span> {source.label}</li>)}</ul> : <p className="mt-2 text-xs text-stone-500">{text.noSources}</p>}<p className="mt-3 text-xs leading-5 text-stone-500">{text.generated}: {date(result.createdAt)} · {text.captured}: {date(result.capturedAt)}</p>{result.contextLimited ? <p className="mt-2 text-xs leading-5 text-stone-500">{text.partial}</p> : null}<p className="mt-1 text-xs leading-5 text-stone-500">{text.review}</p></div>
  </article>;
}

export function CrmAiAssistant({ workspaceId, projectId, language }: { workspaceId: string; projectId?: string | null; language: AssistantLanguage }) {
  const text = assistantCopy[language];
  const contextKey = `${workspaceId}:${projectId ?? ""}`;
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const endpoint = endpointFor(workspaceId, language, timeZone, projectId);
  const [load, setLoad] = useState<LoadState>({ context: contextKey, state: "loading", snapshot: null });
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState({ context: contextKey, mode: "daily_briefing" as AssistantMode, outputLanguage: language, leadId: "", propertyId: "", prompt: "", sourceText: "", tone: "professional" as NonNullable<AssistantRequest["tone"]> });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [selected, setSelected] = useState<{ context: string; result: AssistantResult } | null>(null);
  const operations = useRef(new Map<string, Operation>());
  const inflight = useRef(new Set<string>());
  const activeContext = useRef(contextKey);

  useEffect(() => {
    activeContext.current = contextKey;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoad({ context: contextKey, state: "loading", snapshot: null });
      setForm({ context: contextKey, mode: "daily_briefing", outputLanguage: language, leadId: "", propertyId: "", prompt: "", sourceText: "", tone: "professional" });
      setOperation(operations.current.get(contextKey) ?? null);
      setSelected(null);
      const response = await csrfFetch(endpoint, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as Envelope<AssistantSnapshot>;
      if (!response.ok || !payload.persisted || !payload.data || payload.data.workspaceId !== workspaceId || (payload.data.scope.projectId ?? null) !== (projectId ?? null)) throw new Error("unavailable");
      if (!controller.signal.aborted) {
        const pending = payload.data.pendingRun;
        if (pending && !inflight.current.has(contextKey)) {
          const resumed: Operation = { context: contextKey, key: pending.id, body: pending.request, endpoint: endpointFor(workspaceId, pending.request.language, pending.request.timeZone ?? timeZone, projectId), state: "pending" };
          operations.current.set(contextKey, resumed);
          setOperation(resumed);
          setForm({ context: contextKey, mode: pending.request.mode, outputLanguage: pending.request.language, leadId: pending.request.leadId ?? "", propertyId: pending.request.propertyId ?? "", prompt: pending.request.prompt, sourceText: pending.request.sourceText ?? "", tone: pending.request.tone ?? "professional" });
        }
        setLoad({ context: contextKey, state: "ready", snapshot: payload.data });
      }
    }).catch(() => { if (!controller.signal.aborted) setLoad({ context: contextKey, state: "error", snapshot: null }); });
    return () => { controller.abort(); activeContext.current = ""; };
  }, [contextKey, endpoint, workspaceId, projectId, reload, timeZone, language]);

  const snapshot = load.context === contextKey && load.state === "ready" ? load.snapshot : null;
  const current = operation?.context === contextKey ? operation : null;
  const allowedModes = snapshot?.allowedModes ?? ASSISTANT_MODES;
  const scopedForm = form.context === contextKey ? form : { context: contextKey, mode: "daily_briefing" as AssistantMode, outputLanguage: language, leadId: "", propertyId: "", prompt: "", sourceText: "", tone: "professional" as const };
  const currentForm = allowedModes.includes(scopedForm.mode) ? scopedForm : { ...scopedForm, mode: allowedModes[0] ?? "daily_briefing" };
  const locked = !!current && ["sending", "pending", "uncertain"].includes(current.state);
  const result = selected?.context === contextKey ? selected.result : current?.result ?? null;
  const leadRequired = currentForm.mode === "lead_summary";
  const propertyRequired = currentForm.mode === "property_text";
  const validation = leadRequired && !currentForm.leadId ? text.missingLead : propertyRequired && !currentForm.propertyId ? text.missingProperty : currentForm.mode === "crm_question" && !currentForm.prompt.trim() ? text.emptyQuestion : "";
  const exhausted = !!snapshot && snapshot.credits.availableCredits <= 0;
  const showLead = leadRequired || currentForm.mode === "email_draft";
  const number = (value: number) => value.toLocaleString(language);
  const date = (value: string) => new Date(value).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
  function updateForm(update: Partial<typeof form>) { setForm({ ...currentForm, ...update }); }
  function errorMessage(code?: string) {
    if (code === "AI_PROVIDER_OUTCOME_UNKNOWN") return text.providerUnknown;
    if (code === "AI_PROVIDER_NOT_CONFIGURED" || code === "AI_ASSISTANT_UNAVAILABLE") return text.providerUnavailable;
    if (code === "AI_CREDITS_EXHAUSTED") return text.exhausted;
    if (code === "AI_ASSISTANT_BUSY") return text.busy;
    if (code === "FORBIDDEN" || code === "AI_ASSISTANT_FORBIDDEN" || code === "UNAUTHENTICATED") return text.forbidden;
    if (code === "INVALID_INPUT" || code === "VALIDATION_ERROR" || code === "AI_ASSISTANT_INVALID_REQUEST") return text.invalid;
    return text.failed;
  }
  async function execute(attempt: Operation) {
    if (inflight.current.has(attempt.context)) return;
    inflight.current.add(attempt.context);
    const sending: Operation = { ...attempt, state: "sending", code: undefined };
    operations.current.set(attempt.context, sending);
    if (activeContext.current === attempt.context) { setOperation(sending); setSelected(null); }
    let next: Operation;
    try {
      const response = await csrfFetch(attempt.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key }, body: JSON.stringify(attempt.body) });
      const payload = await response.json() as Envelope<AssistantResult>;
      const code = payload.code ?? (typeof payload.error === "object" ? payload.error?.code : undefined);
      if (response.status === 202 || code === "AI_RESULT_PENDING" || code === "AI_REQUEST_PROCESSING") next = { ...attempt, state: "pending", code };
      else if (response.ok && payload.persisted && payload.data?.status === "completed") next = { ...attempt, state: "completed", result: payload.data };
      else {
        const rejectedBeforeExecution = ["AI_CREDITS_EXHAUSTED", "AI_ASSISTANT_BUSY", "FORBIDDEN", "VALIDATION_ERROR", "AI_PROVIDER_NOT_CONFIGURED"].includes(code ?? "");
        next = { ...attempt, state: payload.terminal === true || rejectedBeforeExecution ? "failed" : "uncertain", code };
      }
    } catch { next = { ...attempt, state: "uncertain" }; }
    inflight.current.delete(attempt.context);
    operations.current.set(attempt.context, next);
    if (activeContext.current !== attempt.context) return;
    setOperation(next);
    if (next.state === "completed" || next.state === "failed") {
      // Refresh quota and history without replacing the generated answer or form.
      void csrfFetch(attempt.endpoint, { cache: "no-store" }).then(async response => {
        const payload = await response.json() as Envelope<AssistantSnapshot>;
        if (response.ok && payload.persisted && payload.data?.workspaceId === workspaceId && (payload.data.scope.projectId ?? null) === (projectId ?? null) && activeContext.current === attempt.context) setLoad({ context: attempt.context, state: "ready", snapshot: payload.data });
      }).catch(() => {});
    }
  }
  function submit() {
    if (!snapshot || locked || validation || exhausted || !allowedModes.includes(currentForm.mode)) return;
    const body: AssistantRequest = { mode: currentForm.mode, prompt: currentForm.prompt.trim(), language: currentForm.outputLanguage, timeZone };
    if (projectId) body.projectId = projectId;
    if (showLead && currentForm.leadId) body.leadId = currentForm.leadId;
    if (propertyRequired) body.propertyId = currentForm.propertyId;
    if (currentForm.mode === "email_draft") { body.tone = currentForm.tone; if (currentForm.sourceText.trim()) body.sourceText = currentForm.sourceText.trim(); }
    void execute({ context: contextKey, key: crypto.randomUUID(), endpoint, body, state: "sending" });
  }

  return <section className="grid min-w-0 gap-5" aria-label={text.title} data-crm-ai-assistant>
    <header className={cardClass}><div className="flex flex-wrap items-start justify-between gap-5"><div className="max-w-2xl"><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">{text.badge}</p><h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{text.title}</h2><p className="mt-3 text-sm leading-6 text-stone-600">{text.subtitle}</p></div><button className={buttonClass} type="button" disabled={current?.state === "sending" || (load.context === contextKey && load.state === "loading")} onClick={() => setReload(value => value + 1)}>{text.refresh}</button></div></header>
    {load.context !== contextKey || load.state === "loading" ? <div className={cardClass} role="status">{text.loading}</div> : !snapshot ? <div className={cardClass} role="status"><p className="text-sm leading-6 text-stone-700">{text.unavailable}</p><button className={`${buttonClass} mt-4`} type="button" onClick={() => setReload(value => value + 1)}>{text.retry}</button></div> : <>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]"><article className={cardClass}><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-medium text-stone-500">{text.scope}</p><h3 className="mt-1 break-words text-base font-semibold text-slate-950">{snapshot.scope.label}</h3></div><p className="text-xs leading-5 text-stone-500">{text.captured}: {date(snapshot.capturedAt)}</p></div><dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">{[[text.openLeads, number(snapshot.metrics.openLeads)], [text.overdue, number(snapshot.metrics.overdueTasks)], [text.meetings, number(snapshot.metrics.todayMeetings)], ...(allowedModes.includes("pipeline_analysis") ? [[text.pipeline, new Intl.NumberFormat(language, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(snapshot.metrics.pipelineValueCents / 100)]] : [])].map(([label, value]) => <div className="min-w-0" key={label}><dt className="text-xs leading-5 text-stone-500">{label}</dt><dd className="mt-1 break-words text-xl font-semibold text-slate-900">{value}</dd></div>)}</dl>{snapshot.contextLimited ? <p className="mt-4 text-xs leading-5 text-stone-500">{text.scopeNote}</p> : null}</article><article className="min-w-0 rounded-xl border border-emerald-200 bg-emerald-50 p-5 sm:p-6"><p className="text-xs font-semibold text-emerald-800">{text.available}</p><p className="mt-2 text-3xl font-semibold text-emerald-950">{number(snapshot.credits.availableCredits)}</p><p className="mt-1 text-xs leading-5 text-emerald-800">{text.shared}</p>{snapshot.credits.reservedCredits > 0 ? <p className="mt-2 text-xs text-emerald-800">{text.reserved}: {number(snapshot.credits.reservedCredits)}</p> : null}<a className="mt-3 inline-block text-sm font-semibold text-emerald-900 underline underline-offset-4" href="#billing">{text.billing}</a></article></div>
      <article className={cardClass}><h3 className="text-lg font-semibold text-slate-950">{text.choose}</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{allowedModes.map((mode, index) => <button className={`flex min-h-28 min-w-0 gap-3 rounded-xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-60 ${currentForm.mode === mode ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-white hover:border-emerald-300 hover:bg-stone-50"}`} type="button" disabled={locked} key={mode} aria-pressed={currentForm.mode === mode} onClick={() => updateForm({ mode })}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-xs font-semibold text-emerald-800" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><span className="block text-sm font-semibold text-slate-900">{text.modes[mode].title}</span><span className="mt-1 block text-xs leading-5 text-stone-600">{text.modes[mode].description}</span></span></button>)}</div></article>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"><article className={cardClass}><h3 className="text-lg font-semibold text-slate-950">{text.prepare}</h3><p className="mt-1 text-sm text-stone-600">{text.modes[currentForm.mode].title}</p><form className="mt-5 grid gap-4" onSubmit={event => { event.preventDefault(); submit(); }}>
        <label className="grid gap-2 text-sm font-medium text-slate-800">{text.outputLanguage}<select aria-label={text.outputLanguage} className={inputClass} value={currentForm.outputLanguage} disabled={locked} onChange={event => updateForm({ outputLanguage: event.target.value as AssistantLanguage })}><option value="de">Deutsch</option><option value="en">English</option><option value="es">Español</option></select></label>
        {showLead ? <label className="grid gap-2 text-sm font-medium text-slate-800">{text.lead}{!leadRequired ? ` (${text.optional})` : ""}<select aria-label={text.lead} className={inputClass} value={currentForm.leadId} disabled={locked} required={leadRequired} onChange={event => updateForm({ leadId: event.target.value })}><option value="">{leadRequired ? text.chooseLead : text.noLead}</option>{snapshot.options.leads.map(lead => <option value={lead.id} key={lead.id}>{lead.label}</option>)}</select></label> : null}
        {showLead && !snapshot.options.leads.length ? <p className="text-sm leading-6 text-stone-600">{text.noLeads}</p> : null}
        {propertyRequired ? <label className="grid gap-2 text-sm font-medium text-slate-800">{text.property}<select aria-label={text.property} className={inputClass} value={currentForm.propertyId} disabled={locked} required onChange={event => updateForm({ propertyId: event.target.value })}><option value="">{text.chooseProperty}</option>{snapshot.options.properties.map(property => <option value={property.id} key={property.id}>{property.label}</option>)}</select></label> : null}
        {propertyRequired && !snapshot.options.properties.length ? <p className="text-sm leading-6 text-stone-600">{text.noProperties}</p> : null}
        <label className="grid gap-2 text-sm font-medium text-slate-800">{currentForm.mode === "crm_question" ? text.questionPrompt : `${text.prompt} (${text.optional})`}<textarea aria-label={currentForm.mode === "crm_question" ? text.questionPrompt : `${text.prompt} (${text.optional})`} className={`${inputClass} min-h-32 resize-y leading-6`} value={currentForm.prompt} disabled={locked} maxLength={2000} required={currentForm.mode === "crm_question"} placeholder={text.modes[currentForm.mode].placeholder} onChange={event => updateForm({ prompt: event.target.value })} /></label>
        {currentForm.mode === "email_draft" ? <><label className="grid gap-2 text-sm font-medium text-slate-800">{text.source} ({text.optional})<textarea aria-label={`${text.source} (${text.optional})`} className={`${inputClass} min-h-32 resize-y leading-6`} value={currentForm.sourceText} disabled={locked} maxLength={6000} onChange={event => updateForm({ sourceText: event.target.value })} /><span className="text-xs font-normal leading-5 text-stone-500">{text.sourceHint}</span></label><label className="grid gap-2 text-sm font-medium text-slate-800">{text.tone}<select aria-label={text.tone} className={inputClass} value={currentForm.tone} disabled={locked} onChange={event => updateForm({ tone: event.target.value as NonNullable<AssistantRequest["tone"]> })}><option value="professional">{text.professional}</option><option value="friendly">{text.friendly}</option><option value="concise">{text.concise}</option></select></label></> : null}
        {exhausted ? <p className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950" role="status">{text.exhausted} <a className="font-semibold underline" href="#billing">{text.billing}</a></p> : null}
        {current && (current.state === "pending" || current.state === "uncertain") ? <div className="rounded-lg bg-amber-50 p-4" role="status"><p className="text-sm leading-6 text-amber-950">{current.state === "pending" ? text.pending : text.uncertain}</p><button className={`${buttonClass} mt-3`} type="button" onClick={() => void execute(current)}>{text.check}</button></div> : current?.state === "failed" ? <p className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950" role="alert">{errorMessage(current.code)}</p> : null}
        <button className={primaryButtonClass} type="submit" disabled={locked || !!validation || exhausted || !allowedModes.includes(currentForm.mode)}>{current?.state === "sending" ? text.generating : text.generate}</button>
        {validation && !locked && !exhausted ? <p className="text-xs text-stone-500">{validation}</p> : null}
        {current?.state === "sending" ? <p className="text-sm text-stone-600" role="status">{text.generating}</p> : null}
      </form></article><div className="grid min-w-0 gap-5">{result ? <ResultCard key={result.id} result={result} language={language} /> : <article className={`${cardClass} grid min-h-60 content-center text-center`}><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-xl text-emerald-800" aria-hidden="true">✦</div><h3 className="text-lg font-semibold text-slate-950">{text.empty}</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-stone-600">{text.emptyHint}</p></article>}<article className={cardClass}><h3 className="text-base font-semibold text-slate-950">{text.history}</h3>{snapshot.recentRuns.length ? <ul className="mt-4 divide-y divide-stone-100">{snapshot.recentRuns.map(run => <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0" key={run.id}><div className="min-w-0"><p className="break-words text-sm font-medium text-slate-800">{text.modes[run.mode].title}</p><p className="mt-1 text-xs text-stone-500">{date(run.createdAt)}</p></div><button type="button" className={buttonClass} onClick={() => setSelected({ context: contextKey, result: run })}>{text.open}</button></li>)}</ul> : <p className="mt-3 text-sm leading-6 text-stone-500">{text.noHistory}</p>}</article></div></div>
    </>}
  </section>;
}
