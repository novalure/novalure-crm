"use client";

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { LanguageCode } from "@/lib/i18n";
import type { ManagedWebsiteIntegration } from "@/lib/integrations/website-integration-management";
import { getWebsiteIntegrationCopy, websiteChatEmbedCode } from "@/lib/integrations/website-integration-copy";
import type { KnowledgeCenterSnapshot } from "@/lib/knowledge-center/types";
import { csrfFetch } from "@/lib/security/csrf-client";

const inputClass = "evelyn-domain-input min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:bg-stone-100";
const buttonClass = "evelyn-domain-button min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} evelyn-domain-button-primary border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900`;
type WebsiteList = { integrations: ManagedWebsiteIntegration[]; permissions: { canManage: boolean; canPause: boolean } };
type Editor = {
  id: string; expectedUpdatedAt: string; projectId: string; knowledgeAssistantId: string; domains: string;
  mode: "training" | "real_customer"; status: "test" | "active" | "disabled" | "revoked";
  brandName: string; assistantName: string; welcomeMessage: string; primaryColor: string;
  language: string; widgetPosition: "bottom_left" | "bottom_right";
};
type Props = {
  snapshot: KnowledgeCenterSnapshot; language: LanguageCode; scopedPath: (path: string) => string;
  active: boolean;
  onAssignKnowledge: (assistantId: string) => void;
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-800">
    <span>{label}</span>{children}{hint ? <span className="text-xs font-normal leading-5 text-stone-600">{hint}</span> : null}
  </label>;
}
function widgetText(widget: Record<string, unknown>, key: string, fallback: string) {
  return typeof widget[key] === "string" ? widget[key] as string : fallback;
}

export function WebsiteIntegrationPanel({ snapshot, language, scopedPath, active, onAssignKnowledge }: Props) {
  const text = getWebsiteIntegrationCopy(language);
  const formId = useId();
  const [data, setData] = useState<WebsiteList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await csrfFetch(scopedPath("/api/integrations/websites"), { cache: "no-store", signal });
    const result = await response.json().catch(() => null) as WebsiteList & { error?: string } | null;
    if (!response.ok || !result || !Array.isArray(result.integrations) || !result.permissions) throw new Error(result?.error || text.loadError);
    return result;
  }, [scopedPath, text.loadError]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    load(controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text.loadError); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, load, text.loadError]);

  async function refresh() {
    setLoading(true); setError("");
    try { setData(await load()); } catch (cause) { setError(cause instanceof Error ? cause.message : text.loadError); }
    finally { setLoading(false); }
  }
  function openEditor(row?: ManagedWebsiteIntegration) {
    const widget = row?.widget ?? {};
    setError(""); setNotice("");
    setEditor({ id: row?.id ?? "", expectedUpdatedAt: row?.updatedAt ?? "", projectId: row?.projectId ?? "",
      knowledgeAssistantId: row?.knowledgeAssistantId ?? "", domains: row?.allowedOrigins.join("\n") ?? "",
      mode: row?.mode ?? "training", status: row?.status ?? "test",
      brandName: widgetText(widget, "brandName", snapshot.workspace.name), assistantName: widgetText(widget, "assistantName", text.assistant),
      welcomeMessage: widgetText(widget, "welcomeMessage", text.defaultWelcome), primaryColor: widgetText(widget, "primaryColor", "#111827"),
      language: widgetText(widget, "language", language), widgetPosition: widget.widgetPosition === "bottom_left" ? "bottom_left" : "bottom_right" });
  }
  function update(patch: Partial<Editor>) { setEditor(current => current ? { ...current, ...patch } : current); }

  async function mutate(body: Record<string, unknown>, method: "POST" | "PATCH") {
    const response = await csrfFetch(scopedPath("/api/integrations/websites"), {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null) as { integration?: ManagedWebsiteIntegration; error?: string; code?: string } | null;
    if (!response.ok || !result?.integration) throw new Error(response.status === 409 && result?.code === "CONFLICT" ? text.conflict : result?.error || text.saveError);
    const integration = result.integration;
    setData(current => current ? { ...current, integrations: [integration, ...current.integrations.filter(row => row.id !== integration.id)] } : current);
    return integration;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editor || !data?.permissions.canManage || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await mutate({ ...(editor.id ? { integrationId: editor.id, expectedUpdatedAt: editor.expectedUpdatedAt, status: editor.status } : { projectId: editor.projectId || null }),
        knowledgeAssistantId: editor.knowledgeAssistantId || null,
        allowedOrigins: editor.domains.split(/\r?\n/u).map(value => value.trim()).filter(Boolean),
        mode: editor.id ? editor.mode : "training",
        widget: { brandName: editor.brandName, assistantName: editor.assistantName, welcomeMessage: editor.welcomeMessage,
          primaryColor: editor.primaryColor, language: editor.language, widgetPosition: editor.widgetPosition },
      }, editor.id ? "PATCH" : "POST");
      setEditor(null); setNotice(text.saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : text.saveError); }
    finally { setBusy(false); }
  }
  async function pause(row: ManagedWebsiteIntegration) {
    if (busy || !data?.permissions.canPause) return;
    setBusy(true); setError(""); setNotice("");
    try { await mutate({ integrationId: row.id, expectedUpdatedAt: row.updatedAt, status: "disabled" }, "PATCH"); setNotice(text.saved); }
    catch (cause) { setError(cause instanceof Error ? cause.message : text.saveError); }
    finally { setBusy(false); }
  }
  async function copy(code: string) {
    setNotice("");
    try { await navigator.clipboard.writeText(code); setNotice(text.copied); }
    catch { setNotice(text.copyError); }
  }

  const compatibleBots = snapshot.bots.filter(bot => (bot.projectId ?? "") === (editor?.projectId ?? ""));
  const selectedRow = editor?.id ? data?.integrations.find(row => row.id === editor.id) : null;
  const count = snapshot.usage.connectedAssistants;
  const statusLabel = (status: ManagedWebsiteIntegration["status"]) => text[status];
  return <section aria-labelledby={`${formId}-title`} className="evelyn-knowledge-section grid gap-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl"><h4 id={`${formId}-title`} className="text-lg font-semibold">{text.title}</h4><p className="mt-2 text-sm leading-6 text-stone-600">{text.intro}</p></div>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={loading || busy} onClick={() => void refresh()} type="button">{text.refresh}</button>
        {data?.permissions.canManage ? <button className={primaryClass} disabled={busy} onClick={() => openEditor()} type="button">{text.add}</button> : null}
      </div>
    </div>
    {typeof count === "number" ? <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm"><p className="font-semibold">{text.count}: {count} / {snapshot.entitlement.limits.maxAssistants}</p><p className="mt-1 text-xs leading-5 text-stone-600">{text.countHelp}</p></div> : null}
    {loading ? <p role="status">{text.loading}</p> : null}
    {error ? <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">{error}</p> : null}
    {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950" role="status">{notice}</p> : null}
    {data && !data.permissions.canManage ? <p className="rounded-lg bg-stone-100 p-3 text-sm">{text.readonly}</p> : null}
    {editor ? <form onSubmit={event => void save(event)} className="grid gap-5 rounded-xl border border-emerald-200 bg-white p-5">
      <h5 className="font-semibold">{editor.id ? text.edit : text.add}</h5>
      <fieldset disabled={busy || !data?.permissions.canManage} className="grid min-w-0 gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={text.project} hint={editor.id ? text.projectFixed : undefined}><select className={inputClass} disabled={Boolean(editor.id)} value={editor.projectId} onChange={event => update({ projectId: event.target.value, knowledgeAssistantId: "" })}>
            <option value="">{text.company}</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></Field>
          <Field label={text.assistant} hint={text.assistantHelp}><select className={inputClass} required={!editor.id} value={editor.knowledgeAssistantId} onChange={event => update({ knowledgeAssistantId: event.target.value })}>
            <option value="">{editor.id ? text.noAssistant : text.selectAssistant}</option>
            {compatibleBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select></Field>
        </div>
        {editor.knowledgeAssistantId ? <div><button className={buttonClass} onClick={() => onAssignKnowledge(editor.knowledgeAssistantId)} type="button">{text.knowledge}</button></div> : null}
        <Field label={text.domains} hint={text.domainsHelp}><textarea className={inputClass} maxLength={6000} required rows={3} value={editor.domains} onChange={event => update({ domains: event.target.value })} placeholder="https://www.example.com" spellCheck={false} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={text.brand}><input className={inputClass} maxLength={120} required value={editor.brandName} onChange={event => update({ brandName: event.target.value })} /></Field>
          <Field label={text.assistantName}><input className={inputClass} maxLength={120} required value={editor.assistantName} onChange={event => update({ assistantName: event.target.value })} /></Field>
        </div>
        <Field label={text.welcome}><textarea className={inputClass} maxLength={500} required rows={2} value={editor.welcomeMessage} onChange={event => update({ welcomeMessage: event.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={text.color}><input className={`${inputClass} p-1`} type="color" value={editor.primaryColor} onChange={event => update({ primaryColor: event.target.value })} /></Field>
          <Field label={text.language}><select className={inputClass} value={editor.language} onChange={event => update({ language: event.target.value })}><option value="de">Deutsch</option><option value="en">English</option><option value="es">Español</option></select></Field>
          <Field label={text.position}><select className={inputClass} value={editor.widgetPosition} onChange={event => update({ widgetPosition: event.target.value as Editor["widgetPosition"] })}><option value="bottom_right">{text.right}</option><option value="bottom_left">{text.left}</option></select></Field>
        </div>
        {editor.id ? <div className="grid gap-4 sm:grid-cols-2">
          <Field label={text.mode}><select className={inputClass} value={editor.mode} onChange={event => update({ mode: event.target.value as Editor["mode"] })}><option value="training">{text.training}</option><option value="real_customer">{text.live}</option></select></Field>
          <Field label={text.status}><select className={inputClass} value={editor.status} onChange={event => update({ status: event.target.value as Editor["status"] })}>{(["test", "active", "disabled", "revoked"] as const).map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></Field>
        </div> : <p className="rounded-lg bg-stone-50 p-3 text-sm">{text.newHelp}</p>}
        {editor.mode === "training" ? <p className="text-xs leading-5 text-stone-600">{text.trainingHelp}</p> : null}
        {selectedRow?.readiness && !selectedRow.readiness.ready ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{selectedRow.readiness.message || text.notReady}</p> : null}
      </fieldset>
      <div className="flex flex-wrap gap-2"><button className={primaryClass} disabled={busy || !data?.permissions.canManage} type="submit">{busy ? text.saving : text.save}</button><button className={buttonClass} disabled={busy} onClick={() => setEditor(null)} type="button">{text.cancel}</button></div>
    </form> : null}
    {!loading && data?.integrations.length === 0 ? <p className="rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-10 text-center font-semibold">{text.empty}</p> : null}
    <ul className="grid gap-4">
      {data?.integrations.map(row => {
        const snippet = row.knowledgeAssistantId ? websiteChatEmbedCode(row.publicSiteKey) : "";
        const paused = row.status === "disabled" || row.status === "revoked";
        return <li className="min-w-0 rounded-xl border border-stone-200 bg-white p-5" key={row.id}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h5 className="break-words font-semibold">{widgetText(row.widget, "brandName", row.allowedOrigins[0] || text.tab)}</h5><p className="mt-1 break-words text-sm text-stone-600">{row.allowedOrigins.join(" · ")}</p><p className="mt-2 text-xs font-medium">{statusLabel(row.status)} · {row.mode === "training" ? text.training : text.live}</p></div>
            <div className="flex flex-wrap gap-2">{data.permissions.canManage ? <button className={buttonClass} disabled={busy} onClick={() => openEditor(row)} type="button">{text.edit}</button> : null}{!paused && data.permissions.canPause ? <button className={buttonClass} disabled={busy} onClick={() => void pause(row)} type="button">{text.pause}</button> : null}</div>
          </div>
          <p className={`mt-4 rounded-lg p-3 text-sm ${row.readiness?.ready ? "bg-emerald-50 text-emerald-950" : "bg-amber-50 text-amber-950"}`}>{row.readiness?.ready ? `${text.ready} · ${row.readiness.publishedSources} ${text.sources}` : row.readiness?.message || text.notReady}</p>
          {paused ? <p className="mt-3 text-sm text-stone-600">{text.notRunning}</p> : null}
          {snippet ? <details className="mt-4"><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{text.embed}</summary><p className="mb-3 text-sm leading-6 text-stone-600">{text.embedHelp}</p><label className="grid gap-2 text-sm font-medium"><span>{text.embed}</span><textarea aria-label={`${text.embed}: ${row.allowedOrigins[0] || row.publicSiteKey}`} className={`${inputClass} font-mono text-xs`} readOnly rows={3} value={snippet} onFocus={event => event.currentTarget.select()} /></label><button className={`${buttonClass} mt-3`} onClick={() => void copy(snippet)} type="button">{text.copy}</button><p className="mt-3 break-all text-xs text-stone-500">{text.publicKey}: {row.publicSiteKey}</p></details> : <p className="mt-3 text-sm text-stone-600">{text.pendingEmbed}</p>}
        </li>;
      })}
    </ul>
  </section>;
}
