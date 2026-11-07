"use client";
import { useMemo, useState } from "react";
import type { Lead, Task, WorkspaceUser } from "@/lib/crm-types";
import { defaultTaskDueInput, formatTaskDue, mergeConfirmedTasks, nextOpenTaskForLead, taskDueState, taskLocalDateTimeToInstant } from "@/lib/task-due";
import { useTaskClock } from "@/lib/use-task-clock";
import { salesFetch } from "@/lib/security/crm-sales-client";

type Props = {
  lead: Lead; tasks?: Task[]; users: WorkspaceUser[]; currentUserId: string | null;
  teamLoading: boolean; teamFailed: boolean; retryTeam: () => void;
  language: "de" | "en"; timeZone?: string; compose: boolean; onComposeClosed: () => void;
  onTasksChanged?: () => void | Promise<void>; onTaskSaved?: (task: Task) => void;
};

/** A confirmed task is shown immediately; the next open item is always scoped to this exact lead. */
export function LeadNextTask({ lead, tasks, users, currentUserId, teamLoading, teamFailed, retryTeam, language, timeZone = "Europe/Vienna", compose, onComposeClosed, onTasksChanged, onTaskSaved }: Props) {
  const de = language === "de", t = (german: string, english: string) => de ? german : english;
  const [overlays, setOverlays] = useState<Task[]>([]);
  const [title, setTitle] = useState((lead.nextAction || lead.intent).slice(0, 180));
  const [due, setDue] = useState(() => defaultTaskDueInput(new Date(), timeZone));
  const [owner, setOwner] = useState(lead.assignedToUserId ?? "");
  const [actionType,setActionType] = useState<NonNullable<Task["actionType"]>>("task");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [completed, setCompleted] = useState<Task | null>(null);
  const [followOnOpen, setFollowOnOpen] = useState(false);
  const clock = useTaskClock(), referenceNow = useMemo(() => new Date(clock), [clock]);
  const effectiveTasks = useMemo(() => mergeConfirmedTasks(tasks??[],overlays), [overlays, tasks]);
  const next = nextOpenTaskForLead(effectiveTasks, lead, referenceNow, timeZone);
  const nextOwner = users.find(user => user.id === next?.ownerUserId);
  const effectiveOwner = owner || (users.some(user => user.id === currentUserId) ? currentUserId! : "");
  const formOpen = compose || followOnOpen;
  const endpoint = `/api/crm/tasks?workspaceId=${encodeURIComponent(lead.workspaceId)}`;
  async function saveTask(complete: boolean) {
    if (busy) return;
    const dueAt = taskLocalDateTimeToInstant(due, timeZone);
    if (!complete && (!title.trim() || !dueAt || !users.some(user => user.id === effectiveOwner))) { setNotice(t("Titel, gültige Fälligkeit und berechtigte Zuständigkeit sind erforderlich.", "A title, valid due date and authorized owner are required.")); return; }
    if (complete && !next) return;
    setBusy(true); setNotice("");
    try {
      const response = await salesFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(complete ? { task: { ...next!, status: "done" }, expectedVersion: next!.version } : { task: { actionType,title: title.trim(), due: dueAt!.toISOString(), ownerUserId: effectiveOwner, projectId: lead.projectId, leadId: lead.id, contactId: lead.contactId || undefined, priority: "Normal", status: "open" } }) });
      const result = await response.json() as { task?: Task; persisted?: boolean; error?: string };
      if (!response.ok || result.persisted !== true || !result.task || result.task.workspaceId !== lead.workspaceId || result.task.projectId !== lead.projectId || result.task.leadId !== lead.id) throw new Error(result.error || t("Die Speicherung wurde nicht bestätigt.", "Saving was not confirmed."));
      const task = result.task;
      setOverlays(current => [task, ...current.filter(item => item.id !== task.id)]);
      if (complete) { setCompleted(task); setNotice(t("Aufgabe erledigt. Eine Folgeaufgabe kann jetzt angelegt werden.", "Task completed. You can now create a follow-up task.")); }
      else { setFollowOnOpen(false); onComposeClosed(); setCompleted(null); setNotice(t("Aufgabe gespeichert.", "Task saved.")); }
      onTaskSaved?.(task);
      try { await onTasksChanged?.(); }
      catch { setNotice(t("Gespeichert. Die Gesamtansicht konnte noch nicht aktualisiert werden.", "Saved. The main view could not be refreshed yet.")); }
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Speichern fehlgeschlagen.", "Saving failed.")); }
    finally { setBusy(false); }
  }
  return <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
    <h5 className="text-sm font-semibold">{t("Nächste Aufgabe", "Next task")}</h5>
    {next ? <div className="mt-2 text-sm"><p className="break-words font-semibold">{next.title}</p><p className="mt-1 text-stone-600">{formatTaskDue(next.due, language, timeZone, referenceNow)} · {nextOwner?.name ?? t("Zuständigkeit nicht verfügbar", "Owner unavailable")}</p>{taskDueState(next.due, referenceNow, timeZone).overdue && <p className="mt-1 font-medium text-red-700">{t("Überfällig", "Overdue")}</p>}<button type="button" disabled={busy} className="mt-2 min-h-11 rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => void saveTask(true)}>{t("Erledigen", "Complete")}</button></div> : <p className="mt-2 text-sm text-stone-600">{tasks === undefined && overlays.length === 0 ? t("Der Aufgabenbestand ist noch nicht geladen.", "Task records have not been loaded yet.") : t("Keine offene Aufgabe für diesen Lead.", "No open task for this lead.")}</p>}
    {completed && !formOpen && <button type="button" className="mt-2 min-h-11 rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => { setTitle(`${t("Nachfassen", "Follow-up")}: ${completed.title}`.slice(0, 180)); setDue(defaultTaskDueInput(new Date(), timeZone)); setOwner(completed.ownerUserId ?? ""); setActionType("follow_up"); setFollowOnOpen(true); }}>{t("Folgeaufgabe anlegen", "Create follow-up task")}</button>}
    {formOpen && <div className="mt-3 grid gap-3">
      <label className="grid gap-1 text-sm">{t("Art der Aufgabe","Task type")}<select className="rounded-md border border-stone-300 bg-white p-2" value={actionType} disabled={busy} onChange={event=>setActionType(event.target.value as NonNullable<Task["actionType"]>)}><option value="task">{t("Allgemeine Aufgabe","General task")}</option><option value="callback">{t("Rückruf","Callback")}</option><option value="follow_up">{t("Nachfassen","Follow-up")}</option></select></label>
      <label className="grid gap-1 text-sm">{t("Aufgabe", "Task")}<input className="rounded-md border border-stone-300 bg-white p-2" maxLength={180} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label className="grid gap-1 text-sm">{t("Fällig", "Due")} ({timeZone})<input type="datetime-local" className="rounded-md border border-stone-300 bg-white p-2" value={due} disabled={busy} onChange={event => setDue(event.target.value)} /></label>
      <label className="grid gap-1 text-sm">{t("Zuständig", "Owner")}<select className="rounded-md border border-stone-300 bg-white p-2" value={effectiveOwner} disabled={busy || teamLoading} onChange={event => setOwner(event.target.value)}><option value="">{t("Bitte auswählen", "Please select")}</option>{users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label>
      {teamFailed && <button type="button" className="text-left text-xs underline" onClick={retryTeam}>{t("Teamauswahl erneut laden", "Reload team options")}</button>}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || teamLoading || teamFailed} className="min-h-11 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void saveTask(false)}>{busy ? t("Speichern…", "Saving…") : t("Aufgabe speichern", "Save task")}</button><button type="button" disabled={busy} className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm" onClick={() => { setFollowOnOpen(false); onComposeClosed(); }}>{t("Abbrechen", "Cancel")}</button></div>
    </div>}
    {notice && <p className="mt-2 break-words text-sm" role="status">{notice}</p>}
  </div>;
}
