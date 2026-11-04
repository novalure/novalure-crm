"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import { crmNotificationCategories, crmNotificationLabels, defaultCrmNotificationPreferences, type CrmNotification, type CrmNotificationsState } from "@/lib/crm-notifications";
import { CrmNotificationEmailSettings } from "./crm-notification-email-settings";

type Props = { workspaceId: string; projectId?: string | null; language: string; onOpenSource?: (notification: Pick<CrmNotification, "sourceType" | "sourceId" | "projectId">) => void };
const button = "min-h-11 rounded-full border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
export function CrmNotifications(props: Props) { return <Notifications key={`${props.workspaceId}:${props.projectId ?? "all"}`} {...props} />; }
function Notifications({ workspaceId, projectId = null, language, onOpenSource }: Props) {
  const de = language === "de", labels = crmNotificationLabels[de ? "de" : "en"];
  const endpoint = `/api/crm/notifications?workspaceId=${encodeURIComponent(workspaceId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`;
  const [open, setOpen] = useState(false), [state, setState] = useState<CrmNotificationsState | null>(null), [draft, setDraft] = useState(defaultCrmNotificationPreferences);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), busyRef = useRef(false), pending = useRef<{ body: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" }); const result = await response.json() as { data?: CrmNotificationsState; error?: string };
    if (!response.ok || !result.data) throw new Error(result.error || (de ? "Hinweise nicht verfügbar" : "Notifications unavailable"));
    return result.data;
  }, [endpoint, de]);
  useEffect(() => { let alive = true; void load().then((data) => { if (alive) { setState(data); setDraft(data.preferences); } }).catch((error: unknown) => { if (alive) setNotice(error instanceof Error ? error.message : "Hinweise nicht verfügbar"); }); return () => { alive = false; }; }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  async function refresh() {
    if (busyRef.current || dirty) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try { const data = await load(); setState(data); setDraft(data.preferences); } catch (error) { setNotice(error instanceof Error ? error.message : "Hinweise nicht verfügbar"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function command(action: "preferences" | "read" | "digest", extra: Record<string, unknown> = {}) {
    if (busyRef.current || !state) return;
    busyRef.current = true; setBusy(true); setNotice("");
    const attempt = pending.current ?? { body: JSON.stringify({ action, ...extra }), key: crypto.randomUUID() }; pending.current = attempt;
    let confirmed = false;
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.key }, body: attempt.body });
      const result = await response.json() as { persisted?: boolean; data?: { created?: boolean; count?: number; reason?: string }; error?: string };
      if (!response.ok) { if (response.status < 500) { pending.current = null; setUncertain(false); } throw new Error(result.error || (de ? "Vorgang nicht bestätigt" : "Action not confirmed")); }
      if (!result.persisted) throw new Error(de ? "Vorgang nicht bestätigt" : "Action not confirmed");
      confirmed = true; pending.current = null; setUncertain(false);
      const actualAction = (JSON.parse(attempt.body) as { action: string }).action;
      const data = await load(); setState(data);
      if (actualAction === "preferences") { setDraft(data.preferences); setDirty(false); }
      setNotice(actualAction === "digest" ? result.data?.reason === "no_changes" ? (de ? "Keine neuen Änderungen. Es wurde keine weitere Zusammenfassung erstellt." : "No new changes. No additional summary was created.") : (de ? "Zusammenfassung vorbereitet. Es wurde keine E-Mail versandt." : "Summary prepared. No email was sent.") : (de ? "Gespeichert." : "Saved."));
    } catch (error) { if (pending.current) setUncertain(true); setNotice(confirmed ? (de ? "Gespeichert. Die Ansicht konnte nicht aktualisiert werden; bitte neu laden." : "Saved, but the view could not refresh. Please reload.") : error instanceof Error ? error.message : (de ? "Verbindung unterbrochen" : "Connection interrupted")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function detail(item: CrmNotification) {
    if (de) return item.detail;
    return item.category === "new_lead" ? "New enquiry awaiting a response" : item.category === "task_due" ? "Task is overdue or due within 24 hours" : item.category === "reservation_deadline" ? "Review hold or reservation deadline" : item.category === "expose_opened" ? "Exposé opened; attributed to the intended recipient, not a verified identity" : item.detail;
  }
  return <div ref={root} className="relative min-w-0">
    <button ref={trigger} type="button" className={button} aria-expanded={open} aria-controls={`notifications-${workspaceId}`} onClick={() => { setOpen((current) => !current); if (!open && !dirty && !uncertain) void refresh(); }}>{de ? "Hinweise" : "Notifications"}{state?.unread ? <span className="ml-2 rounded-full bg-slate-950 px-2 py-0.5 text-xs text-white" aria-label={de ? "ungelesen in dieser Liste" : "unread in this list"}>{state.unread}</span> : null}</button>
    {open ? <section id={`notifications-${workspaceId}`} className="absolute right-0 z-50 mt-2 max-h-[75vh] w-[min(28rem,90vw)] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-4 shadow-xl" aria-label={de ? "Persönliche Hinweise" : "Personal notifications"}>
      <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">{de ? "Persönliche Hinweise" : "Personal notifications"}</h2><button type="button" className={button} onClick={() => { setOpen(false); trigger.current?.focus(); }}>{de ? "Schließen" : "Close"}</button></div>
      <p className="mt-2 text-xs leading-5 text-stone-600">{de ? "Aktuelle Hinweise aus deinen zugänglichen Daten. Gelesene Hinweise verschwinden; geänderte Fristen erzeugen einen neuen Hinweis. Eine E-Mail-Zusammenfassung erfordert deine separate Aktivierung und einen eingerichteten Zeitplan." : "Current notifications from data you can access. Read notifications disappear; a changed deadline creates a new notification. Email summaries require your separate opt-in and a configured schedule."}</p>
      {notice ? <p role="status" className="mt-3 break-words text-sm">{notice}</p> : null}
      {uncertain ? <button type="button" disabled={busy} className={`${button} mt-3`} onClick={() => void command("read")}>{de ? "Unbestätigten Vorgang erneut prüfen" : "Recheck unconfirmed action"}</button> : null}
      {!state ? <p className="mt-4 text-sm">{de ? "Hinweise werden geladen …" : "Loading notifications …"}</p> : <>
        <div className="mt-3 flex flex-wrap gap-2"><button className={button} type="button" disabled={busy || dirty || uncertain} onClick={() => void refresh()}>{de ? "Aktualisieren" : "Refresh"}</button><button className={button} type="button" disabled={busy || uncertain || !state.unread} onClick={() => void command("read", { keys: state.items.filter((item) => !item.read).map((item) => item.key) })}>{de ? "Diese Liste als gelesen" : "Mark this list as read"}</button></div>
        {state.items.length ? <ul className="mt-4 space-y-3">{state.items.map((item) => <li className="rounded-xl border border-stone-200 p-3" key={item.key}><p className="text-xs font-semibold text-stone-500">{labels[item.category]}</p><p className="mt-1 break-words text-sm font-semibold">{item.title}</p><p className="mt-1 break-words text-xs leading-5 text-stone-600">{detail(item)}</p><p className="mt-1 text-xs text-stone-500">{new Date(item.occurredAt).toLocaleString(de ? "de-AT" : "en-IE", { timeZone: state.preferences.timeZone })}</p><div className="mt-2 flex flex-wrap gap-2">{onOpenSource ? <button type="button" className={button} onClick={() => { onOpenSource(item); setOpen(false); }}>{de ? "Öffnen" : "Open"}</button> : null}<button type="button" className={button} disabled={busy || uncertain} onClick={() => void command("read", { keys: [item.key] })}>{de ? "Gelesen" : "Read"}</button></div></li>)}</ul> : <p className="mt-4 rounded-xl bg-stone-50 p-3 text-sm">{de ? "Keine ungelesenen Hinweise in den gewählten Hinweisarten." : "No unread notifications in the selected categories."}</p>}
        <p className="mt-2 text-xs text-stone-500">{de ? `Bis zu ${state.limit} aktuelle Hinweise in dieser Liste.` : `Up to ${state.limit} current notifications in this list.`}</p>
        <details className="mt-4 border-t border-stone-200 pt-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">{de ? "Meine Einstellungen" : "My preferences"}{dirty ? (de ? " · ungespeichert" : " · unsaved") : ""}</summary><fieldset disabled={busy || uncertain} className="mt-2 space-y-2">{crmNotificationCategories.map((category) => <label className="flex min-h-11 items-start gap-2 text-sm" key={category}><input className="mt-1" type="checkbox" checked={draft.categories[category]} disabled={!state.features[category]} onChange={(event) => { setDraft((current) => ({ ...current, categories: { ...current.categories, [category]: event.target.checked } })); setDirty(true); }} /><span>{labels[category]}{!state.features[category] ? <span className="block text-xs text-stone-500">{de ? "Für dieses Konto derzeit nicht verfügbar" : "Currently unavailable for this account"}</span> : null}</span></label>)}<label className="block text-sm font-medium">{de ? "Meine Zeitzone" : "My timezone"}<input className="mt-1 min-h-11 w-full rounded-xl border border-stone-300 px-3 py-2" maxLength={80} value={draft.timeZone} onChange={(event) => { setDraft((current) => ({ ...current, timeZone: event.target.value })); setDirty(true); }} /></label></fieldset><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || uncertain || !dirty} onClick={() => void command("preferences", { preferences: draft, expectedRevision: state.revision })}>{de ? "Einstellungen speichern" : "Save preferences"}</button>{dirty ? <button type="button" className={button} disabled={busy || uncertain} onClick={() => { setDraft(state.preferences); setDirty(false); }}>{de ? "Entwurf verwerfen" : "Discard draft"}</button> : null}</div></details>
        <details className="mt-4 border-t border-stone-200 pt-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">{de ? "Änderungsübersicht" : "Change summary"}</summary><p className="mt-2 text-sm text-stone-600">{de ? "Zusammenfassungen berücksichtigen nur neue, ungelesene Hinweise seit der letzten Vorbereitung. Bei unverändertem Stand entsteht keine weitere oder leere Zusammenfassung. Diese manuelle Übersicht versendet keine E-Mail. Den eigenen E-Mail-Zeitplan richten Sie separat unten ein." : "Summaries include only new unread notifications since the last preparation. Unchanged data does not create another or empty summary. This manual summary sends no email. Configure the separate email schedule below."}</p><button type="button" className={`${button} mt-3`} disabled={busy || uncertain} onClick={() => void command("digest")}>{de ? "Neue Änderungen zusammenfassen" : "Prepare new change summary"}</button>{state.digests.length ? <ul className="mt-3 space-y-2 text-xs text-stone-600">{state.digests.map((digest) => <li key={digest.id}>{digest.count} {de ? "Hinweise vorbereitet · nicht versandt" : "notifications prepared · not sent"} · {new Date(digest.createdAt).toLocaleString(de ? "de-AT" : "en-IE", { timeZone: state.preferences.timeZone })}</li>)}</ul> : null}</details>
        <details className="mt-4 border-t border-stone-200 pt-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">{de ? "E-Mail-Zusammenfassung und Zeitplan" : "Email summary and schedule"}</summary><CrmNotificationEmailSettings workspaceId={workspaceId} projectId={projectId} language={language} /></details>
      </>}
    </section> : null}
  </div>;
}
