"use client";
import { useEffect, useRef, useState } from "react";
import { crmActivityKinds, crmActivityKindLabel, type CrmActivityItem, type CrmActivityKind, type CrmActivityPage, type CrmActivityScope } from "@/lib/crm-activity";
import { taskLocalDateTimeToInstant } from "@/lib/task-due";
import { csrfFetch } from "@/lib/security/csrf-client";

type Props = CrmActivityScope & { workspaceId: string; language: "de" | "en"; timeZone?: string; canWrite?: boolean; onRecorded?: (item: CrmActivityItem) => void };
function matchesPage(value: CrmActivityPage, scope: { workspaceId: string; contactId?: string; leadId?: string; projectId?: string }) {
  return value?.source === "database" && value.workspaceId === scope.workspaceId && (!scope.contactId || value.contactId === scope.contactId) && value.leadId === (scope.leadId ?? null) && (!scope.projectId || value.projectId === scope.projectId) && Array.isArray(value.items) && value.items.every(item => item.contactId === value.contactId && typeof item.title === "string" && typeof item.detail === "string") && typeof value.canRecord === "boolean";
}
export function ActivityTimeline(props: Props) { return <TimelineSession key={JSON.stringify([props.workspaceId, props.contactId, props.leadId, props.projectId])} {...props} />; }
function TimelineSession({ workspaceId, contactId, leadId, projectId, language, timeZone = "Europe/Vienna", canWrite = true, onRecorded }: Props) {
  const de = language === "de", t = (german: string, english: string) => de ? german : english;
  const [page, setPage] = useState<CrmActivityPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kind, setKind] = useState<CrmActivityKind>("note");
  const [detail, setDetail] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef<{ body: string; key: string; correlation: string } | null>(null);
  const query = new URLSearchParams({ workspaceId });
  if (contactId) query.set("contactId", contactId);
  if (leadId) query.set("leadId", leadId);
  if (projectId) query.set("projectId", projectId);
  const target = `/api/crm/activity?${query}`;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => fetch(target, { cache: "no-store", credentials: "same-origin", signal: controller.signal }))
      .then(async response => {
        const result = await response.json() as CrmActivityPage;
        if (!response.ok || !matchesPage(result, { workspaceId, contactId, leadId, projectId })) throw new Error("Activity unavailable");
        if (!controller.signal.aborted) { setPage(result); setFailed(false); }
      }).catch(() => { if (!controller.signal.aborted) { setPage(null); setFailed(true); } });
    return () => controller.abort();
  }, [target, attempt, workspaceId, contactId, leadId, projectId]);

  async function more() {
    if (!page?.nextCursor || loadingMore || saving) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`${target}&cursor=${encodeURIComponent(page.nextCursor)}`, { cache: "no-store", credentials: "same-origin" });
      const result = await response.json() as CrmActivityPage;
      if (!response.ok || !matchesPage(result, { workspaceId, contactId, leadId, projectId })) throw new Error("unavailable");
      setPage(current => current ? { ...result, items: [...current.items, ...result.items.filter(item => !current.items.some(previous => previous.id === item.id))] } : result);
    } catch { setNotice(t("Weitere Aktivitäten konnten nicht geladen werden.", "More activity could not be loaded.")); }
    finally { setLoadingMore(false); }
  }

  async function record() {
    if (saving || !page?.canRecord) return;
    const time = occurredAt ? taskLocalDateTimeToInstant(occurredAt, timeZone) : null;
    if (!uncertain && (!detail.trim() || (occurredAt && !time))) { setNotice(t("Bitte Inhalt und Zeitpunkt prüfen.", "Please check the content and time.")); return; }
    const operation = pending.current ?? { body: JSON.stringify({ ...(contactId ? { contactId } : {}), ...(leadId ? { leadId } : {}), ...(projectId ? { projectId } : {}), kind, title: crmActivityKindLabel(kind, language), detail: detail.trim(), ...(time ? { occurredAt: time.toISOString() } : {}) }), key: crypto.randomUUID(), correlation: crypto.randomUUID() };
    pending.current = operation; setSaving(true); setNotice("");
    try {
      const response = await csrfFetch(`/api/crm/activity?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": operation.key, "X-Correlation-Id": operation.correlation }, body: operation.body });
      if (response.status >= 500) throw new Error("unknown");
      const result = await response.json() as { item?: CrmActivityItem; persisted?: boolean; error?: string };
      if (!response.ok) { pending.current = null; setUncertain(false); throw new Error(result.error || t("Aktivität abgelehnt.", "Activity rejected.")); }
      if (result.persisted !== true || !result.item || result.item.contactId !== page.contactId || result.item.leadId !== page.leadId) throw new Error("unknown");
      const item = result.item;
      pending.current = null; setUncertain(false); setDetail(""); setOccurredAt("");
      setPage(current => current ? { ...current, items: [item, ...current.items.filter(previous => previous.id !== item.id)] } : current);
      setNotice(t("Aktivität gespeichert.", "Activity saved.")); onRecorded?.(item);
    } catch (error) {
      if (pending.current) { setUncertain(true); setNotice(t("Das Speicherergebnis ist noch ungeklärt. Mit „Ergebnis erneut prüfen“ denselben Eintrag abgleichen. Den Dialog bis zur Klärung offen halten.", "The save result is still unknown. Use ‘Check result again’ for the same entry. Keep this view open until resolved.")); }
      else setNotice(error instanceof Error ? error.message : t("Speichern fehlgeschlagen.", "Saving failed."));
    } finally { setSaving(false); }
  }

  function displayTime(value: string) {
    try { return new Intl.DateTimeFormat(de ? "de-DE" : "en-IE", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value)); }
    catch { return t("Zeitpunkt nicht verfügbar", "Time unavailable"); }
  }
  return <section aria-label={t("Aktivitätsverlauf", "Activity history")} className="space-y-3 rounded-lg border border-stone-200 bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">{t("Aktivitätsverlauf", "Activity history")}</h5><button type="button" className="min-h-10 rounded-md border border-stone-200 px-3 py-2 text-xs font-medium" disabled={saving || loadingMore || uncertain} onClick={() => setAttempt(value => value + 1)}>{t("Aktualisieren", "Refresh")}</button></div>
    {failed ? <p className="text-sm text-amber-800" role="status">{t("Der Verlauf ist derzeit nicht verfügbar. Bitte erneut laden.", "History is currently unavailable. Please reload.")}</p> : !page ? <p className="text-sm text-stone-500" role="status">{t("Aktivitäten werden geladen…", "Loading activity…")}</p> : null}
    {page?.items.map(item => <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={item.id}>
      <div className="flex flex-wrap items-start justify-between gap-2"><p className="break-words text-sm font-semibold">{item.title}</p><time dateTime={item.occurredAt} className="text-xs text-stone-500">{displayTime(item.occurredAt)}</time></div>
      <p className="mt-1 text-xs text-stone-500">{crmActivityKindLabel(item.kind, language)}{item.actorName ? ` · ${item.actorName}` : ""}</p>
      {item.detail && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-stone-700">{item.detail}</p>}
    </article>)}
    {page && page.items.length === 0 && !failed && <p className="text-sm text-stone-500">{t("Keine gespeicherten Aktivitäten für diesen Bezug.", "No saved activity for this record.")}</p>}
    {page?.nextCursor && <button type="button" className="min-h-11 rounded-md border border-stone-200 px-3 py-2 text-sm" disabled={saving || loadingMore || uncertain} onClick={() => void more()}>{loadingMore ? t("Laden…", "Loading…") : t("Weitere Aktivitäten", "More activity")}</button>}
    {canWrite && page?.canRecord && <div className="grid gap-3 border-t border-stone-200 pt-3">
      <label className="grid gap-1 text-sm">{t("Aktivität erfassen", "Record activity")}<select value={kind} disabled={saving || uncertain} className="rounded-md border border-stone-300 bg-white p-2" onChange={event => setKind(event.target.value as CrmActivityKind)}>{crmActivityKinds.map(option => <option value={option} key={option}>{crmActivityKindLabel(option, language)}</option>)}</select></label>
      <label className="grid gap-1 text-sm">{t("Inhalt", "Content")}<textarea maxLength={1200} value={detail} disabled={saving || uncertain} className="min-h-24 rounded-md border border-stone-300 p-2" onChange={event => setDetail(event.target.value)} /></label>
      <label className="grid gap-1 text-sm">{t("Zeitpunkt, optional", "Time, optional")} ({timeZone})<input type="datetime-local" value={occurredAt} disabled={saving || uncertain} className="rounded-md border border-stone-300 p-2" onChange={event => setOccurredAt(event.target.value)} /></label>
      <p className="text-xs text-stone-500">{t("Telefonaktivitäten werden als manuell dokumentierte Angaben gespeichert.", "Phone activity is saved as a manually documented record.")}</p>
      <button type="button" className="min-h-11 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={saving || (!uncertain && !detail.trim())} onClick={() => void record()}>{saving ? t("Speichern…", "Saving…") : uncertain ? t("Ergebnis erneut prüfen", "Check result again") : t("Aktivität speichern", "Save activity")}</button>
    </div>}
    {notice && <p className="break-words text-sm" role="status">{notice}</p>}
  </section>;
}
