"use client";

import { useMemo, useState } from "react";
import type { Contact, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import {
  getCrmSourceLabel,
  getCrmSystemTextLabel,
  getCrmTaskPriorityLabel,
  getCrmTaskStatusLabel,
  getTaskCommandCenterCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { salesFetch as csrfFetch } from "@/lib/security/crm-sales-client";
import { compareTaskDue, defaultTaskDueInput, formatTaskDue, mergeConfirmedTasks, taskDueState, taskLocalDateTimeToInstant } from "@/lib/task-due";
import { useTaskClock } from "@/lib/use-task-clock";
import { useCrmTeam } from "@/lib/use-crm-team";

type TaskCommandCenterProps = {
  activeProjectId: string | null;
  contacts: Contact[];
  language: LanguageCode;
  leads: Lead[];
  onTasksChanged?: () => Promise<void> | void;
  projectLabel: string;
  projects: Project[];
  sessionUserId: string;
  sessionUserName: string;
  tasks: Task[];
  users: WorkspaceUser[];
  workspaceId?: string;
  timeZone?: string;
};

type TaskView = "focus" | "today" | "overdue" | "high" | "unlinked" | "followUp" | "all";

type NewTaskDraft = {
  actionType: NonNullable<Task["actionType"]>;
  contactId: string;
  description: string;
  due: string;
  leadId: string;
  ownerUserId: string;
  priority: Task["priority"];
  projectId: string;
  status: Task["status"];
  title: string;
};

const priorityStyles = {
  Hoch: "border-red-200 bg-red-50 text-red-900",
  Mittel: "border-amber-200 bg-amber-50 text-amber-900",
  Normal: "border-stone-200 bg-stone-50 text-stone-700",
} as const;

const viewStyles = {
  active: "border-slate-950 bg-slate-950 text-white",
  idle: "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50",
};

type TaskCommandCenterCopy = ReturnType<typeof getTaskCommandCenterCopy>;
type OwnerDisplay = Pick<WorkspaceUser, "id" | "name" | "email">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function resolveOwnerDisplay(
  ownerUserId: string | undefined,
  users: WorkspaceUser[],
  sessionUserId: string,
  sessionUserName: string,
): OwnerDisplay | undefined {
  if (!ownerUserId) return undefined;
  const owner = users.find((user) => user.id === ownerUserId);
  if (owner) return owner;
  if (ownerUserId === sessionUserId) {
    const fallbackUser = users.find(user => user.id === sessionUserId);
    return {
      email: fallbackUser?.email ?? "",
      id: sessionUserId,
      name: sessionUserName || fallbackUser?.name || fallbackUser?.email || sessionUserId,
    };
  }
  return undefined;
}

function getTaskWriteErrorMessage(reason: string | undefined, text: TaskCommandCenterCopy) {
  if (reason === "Valid owner is required" || reason === "Owner is not available in this workspace") {
    return text.ownerInvalid;
  }
  return reason ?? text.taskCreateFailed;
}

function createDefaultTaskDraft(
  projects: Project[],
  sessionUserId: string,
  activeProjectId: string | null,
  timeZone = "Europe/Vienna",
): NewTaskDraft {
  return {
    actionType: "task",
    contactId: "",
    description: "",
    due: defaultTaskDueInput(new Date(), timeZone),
    leadId: "",
    ownerUserId: sessionUserId,
    priority: "Normal",
    projectId: activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : "",
    status: "open",
    title: "",
  };
}

export function TaskCommandCenter({
  activeProjectId,
  contacts,
  language,
  leads,
  onTasksChanged,
  projectLabel,
  projects,
  sessionUserId,
  sessionUserName,
  tasks,
  users,
  workspaceId,
  timeZone = "Europe/Vienna",
}: TaskCommandCenterProps) {
  const text = getTaskCommandCenterCopy(language);
  const selfOwnerName = sessionUserName || users.find(user => user.id === sessionUserId)?.name || sessionUserId;
  const [activeView, setActiveView] = useState<TaskView>("focus");
  const [searchTerm, setSearchTerm] = useState("");
  const [taskOverlays, setTaskOverlays] = useState<Task[]>([]);
  const [savingTaskIds, setSavingTaskIds] = useState<string[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? "");
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskDraft, setTaskDraft] = useState<NewTaskDraft>(() =>
    createDefaultTaskDraft(projects, sessionUserId, activeProjectId, timeZone),
  );
  const [notice, setNotice] = useState("");
  const clock = useTaskClock();
  const referenceNow = useMemo(() => new Date(clock), [clock]);
  const scopedWorkspaceId = workspaceId ?? projects[0]?.workspaceId ?? tasks[0]?.workspaceId ?? "";
  const team = useCrmTeam(scopedWorkspaceId, taskDraft.projectId || activeProjectId);
  const taskEndpoint = `/api/crm/tasks?workspaceId=${encodeURIComponent(scopedWorkspaceId)}`;
  const effectiveTasks = useMemo(() => {
    return mergeConfirmedTasks(tasks,taskOverlays).filter(task => task.workspaceId === scopedWorkspaceId && (!activeProjectId || task.projectId === activeProjectId));
  }, [taskOverlays, tasks, scopedWorkspaceId, activeProjectId]);
  async function refreshConfirmedTask(taskId: string) {
    if(!onTasksChanged)return;
    try{await onTasksChanged();setTaskOverlays(current=>current.filter(task=>task.id!==taskId));}
    catch{setNotice(language==="de"?"Aufgabe gespeichert. Die Übersicht konnte nicht aktualisiert werden; bitte neu laden.":"Task saved. The list could not be refreshed; please reload.");}
  }

  const decoratedTasks = useMemo(
    () =>
      effectiveTasks.map((task) => {
        const contact = task.contactId
          ? contacts.find((item) => item.id === task.contactId)
          : undefined;
        const lead = task.leadId ? leads.find((item) => item.id === task.leadId) : undefined;
        const project = projects.find((item) => item.id === task.projectId);
        const isCompleted = task.status === "done";

        return {
          task,
          contact,
          lead,
          leadIntentLabel: lead ? getCrmSystemTextLabel(lead.intent, language) : undefined,
          project,
          isCompleted,
          dueState: taskDueState(task.due, referenceNow, timeZone),
        };
      }),
    [contacts, effectiveTasks, language, leads, projects, referenceNow, timeZone],
  );

  const openTasks = decoratedTasks.filter((item) => !item.isCompleted);
  const dueTodayTasks = openTasks.filter((item) => item.dueState.group === "today");
  const overdueTasks = openTasks.filter((item) => item.dueState.overdue);
  const highPriorityTasks = openTasks.filter((item) => item.task.priority === "Hoch");
  const followUpTasks = openTasks.filter((item) => Boolean(item.lead || item.contact));
  const unlinkedTasks = openTasks.filter((item) => !item.contact || !item.project);
  const filteredTasks = decoratedTasks
    .filter((item) => {
      const normalizedQuery = searchTerm.trim().toLowerCase();
      const matchesView =
        activeView === "all" ||
        (activeView === "focus" && !item.isCompleted) ||
        (activeView === "today" && !item.isCompleted && item.dueState.group === "today") ||
        (activeView === "overdue" && !item.isCompleted && item.dueState.overdue) ||
        (activeView === "high" && !item.isCompleted && item.task.priority === "Hoch") ||
        (activeView === "unlinked" && !item.isCompleted && (!item.contact || !item.project)) ||
        (activeView === "followUp" && Boolean(item.lead || item.contact));
      const searchable = [
        item.task.title,
        item.task.project,
        item.task.due,
        item.task.priority,
        item.contact?.name,
        item.contact?.source,
        item.lead?.intent,
        item.leadIntentLabel,
        item.project?.type,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
    })
    .sort((a, b) => compareTaskDue(a.task, b.task, referenceNow, timeZone));
  const selectedTask = decoratedTasks.find((item) => item.task.id === selectedTaskId) ??
    filteredTasks[0] ??
    decoratedTasks[0];
  const selectedOwner = resolveOwnerDisplay(selectedTask?.task.ownerUserId, users, sessionUserId, sessionUserName);
  const assignableUsers = useMemo(
    () => team.users.filter((user) => isUuid(user.id) && user.id !== sessionUserId),
    [sessionUserId, team.users],
  );
  const draftProjects = activeProjectId
    ? projects.filter((project) => project.id === activeProjectId)
    : projects;
  const views: Array<{ id: TaskView; label: string; count: number }> = [
    { id: "focus", label: text.focus, count: openTasks.length },
    { id: "today", label: text.today, count: dueTodayTasks.length },
    { id: "overdue", label: text.overdue, count: overdueTasks.length },
    { id: "high", label: text.high, count: highPriorityTasks.length },
    { id: "unlinked", label: text.unlinked, count: unlinkedTasks.length },
    { id: "followUp", label: text.followUp, count: followUpTasks.length },
    { id: "all", label: text.all, count: decoratedTasks.length },
  ];

  const updateTaskDraft = (field: keyof NewTaskDraft, value: string) => {
    setTaskDraft((current) => ({ ...current, [field]: value }));
  };

  const createTask = async () => {
    if (!taskDraft.title.trim()) {
      setNotice(text.titleRequired);
      return;
    }
    if (!draftProjects.some((project) => project.id === taskDraft.projectId)) {
      setNotice(language === "de" ? "Projekt ist erforderlich." : "Project is required.");
      return;
    }
    if (!team.users.some(user => user.id === taskDraft.ownerUserId)) {
      setNotice(text.ownerInvalid);
      return;
    }
    const dueAt = taskDraft.due ? taskLocalDateTimeToInstant(taskDraft.due, timeZone) : null;
    if (taskDraft.due && !dueAt) {
      setNotice(language === "de" ? `Fälligkeit ist in ${timeZone} ungültig. Bitte Datum und Uhrzeit prüfen.` : `The due date is invalid in ${timeZone}. Please check the date and time.`);
      return;
    }

    setTaskSaving(true);
    setNotice("");
    try {
      const response = await csrfFetch(taskEndpoint, {
        body: JSON.stringify({
          task: {
            actionType: taskDraft.actionType,
            contactId: taskDraft.contactId || undefined,
            description: taskDraft.description.trim() || undefined,
            due: dueAt?.toISOString() ?? "",
            leadId: taskDraft.leadId || undefined,
            ownerUserId: taskDraft.ownerUserId || undefined,
            priority: taskDraft.priority,
            projectId: taskDraft.projectId || undefined,
            status: taskDraft.status,
            title: taskDraft.title.trim(),
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; task?: Task };

      if (!response.ok || !payload.task) {
        throw new Error(getTaskWriteErrorMessage(payload.error, text));
      }

      setTaskOverlays((current) => [payload.task!, ...current.filter((task) => task.id !== payload.task!.id)]);
      setSelectedTaskId(payload.task.id);
      setTaskDraft(createDefaultTaskDraft(projects, sessionUserId, activeProjectId, timeZone));
      setIsCreateOpen(false);
      setNotice(text.taskCreated);
      await refreshConfirmedTask(payload.task.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : text.taskCreateFailed);
    } finally {
      setTaskSaving(false);
    }
  };

  const toggleTask = (taskId: string) => {
    const currentTask = decoratedTasks.find((item) => item.task.id === taskId);
    if (!currentTask || savingTaskIds.includes(taskId)) return;
    const nextStatus = currentTask.isCompleted ? "open" : "done";
    setSavingTaskIds((current) => [...current, taskId]);
    void csrfFetch(taskEndpoint, {
      body: JSON.stringify({ task: { ...currentTask.task, status: nextStatus }, expectedVersion: currentTask.task.version }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as { task?: Task; error?: string };
        if (!response.ok || !payload.task) throw new Error(payload.error || text.taskCreateFailed);
        setTaskOverlays((current) => [payload.task!, ...current.filter((task) => task.id !== payload.task!.id)]);
        await refreshConfirmedTask(payload.task.id);
      })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : text.taskCreateFailed))
      .finally(() => setSavingTaskIds((current) => current.filter((id) => id !== taskId)));
  };

  const prepareTaskFollowUp = async () => {
    if (!selectedTask) return;

    setFollowUpSaving(true);
    try {
      const response = await csrfFetch("/api/crm/recommendation-runtime", {
        body: JSON.stringify({
          actionType: selectedTask.task.priority === "Hoch" ? "task_priority_follow_up" : "task_follow_up",
          channel: selectedTask.contact?.email ? "E-Mail" : selectedTask.contact?.phone ? "WhatsApp" : "Telefon",
          contactId: selectedTask.contact?.id ?? selectedTask.task.contactId ?? null,
          email: selectedTask.contact?.email ?? null,
          leadId: selectedTask.lead?.id ?? selectedTask.task.leadId ?? null,
          operation: "follow_up_action",
          outcome: "planned",
          phone: selectedTask.contact?.phone ?? null,
          projectId: selectedTask.task.projectId,
          purpose: "salesFollowUp",
          taskTitle: selectedTask.task.title,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { data?: { allowed?: boolean; delivery?: { status?: string } } };
      if (!response.ok) throw new Error(text.followUpFailed);

      setNotice(
        payload.data?.allowed === false
          ? text.followUpBlocked
          : text.followUpQueued(payload.data?.delivery?.status ?? "queued"),
      );
    } catch {
      setNotice(text.followUpFailed);
    } finally {
      setFollowUpSaving(false);
    }
  };

  return (
    <section className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
              {text.description}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {[
              { label: text.dueToday, value: dueTodayTasks.length },
              { label: text.overdue, value: overdueTasks.length },
              { label: text.highPriority, value: highPriorityTasks.length },
              { label: language === "de" ? "Erledigt" : "Completed", value: effectiveTasks.filter(task => task.status === "done").length },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 p-3" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="break-words text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex flex-col items-stretch gap-2 sm:items-end">
          <button
            className="w-full rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
            onClick={() => {
              if (!isCreateOpen) {
                setTaskDraft(createDefaultTaskDraft(projects, sessionUserId, activeProjectId, timeZone));
              }
              setIsCreateOpen((current) => !current);
            }}
            type="button"
          >
            {isCreateOpen ? text.cancel : text.newTask}
          </button>
        </div>
        {isCreateOpen ? (
          <div id="task-create-form" className="mt-4 min-w-0 max-w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="min-w-0">
              <h4 className="text-lg font-semibold">{text.createTaskTitle}</h4>
              <p className="mt-1 break-words text-sm text-stone-600">{text.createTaskDescription}</p>
            </div>
            <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{language==="de"?"Art der Aufgabe":"Task type"}
                <select className="mt-2 min-h-11 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm normal-case tracking-normal text-slate-900" value={taskDraft.actionType} onChange={event=>updateTaskDraft("actionType",event.target.value)}>
                  <option value="task">{language==="de"?"Allgemeine Aufgabe":"General task"}</option><option value="callback">{language==="de"?"Rückruf":"Callback"}</option><option value="follow_up">{language==="de"?"Nachfassen":"Follow-up"}</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                {text.titleField}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("title", event.target.value)}
                  value={taskDraft.title}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                {text.descriptionField}
                <textarea
                  className="mt-2 min-h-24 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("description", event.target.value)}
                  value={taskDraft.description}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.due}
                <span className="ml-1 normal-case tracking-normal">({timeZone})</span>
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("due", event.target.value)}
                  type="datetime-local"
                  value={taskDraft.due}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.priority}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("priority", event.target.value as Task["priority"])}
                  value={taskDraft.priority}
                >
                  {(["Hoch", "Mittel", "Normal"] as Task["priority"][]).map((priority) => (
                    <option key={priority} value={priority}>
                      {getCrmTaskPriorityLabel(priority, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.status}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("status", event.target.value as Task["status"])}
                  value={taskDraft.status}
                >
                  {(["open", "done"] as Task["status"][]).map((status) => (
                    <option key={status} value={status}>
                      {getCrmTaskStatusLabel(status, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.project}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("projectId", event.target.value)}
                  required
                  value={taskDraft.projectId}
                >
                  <option value="">
                    {language === "de" ? "Projekt auswählen" : "Select project"}
                  </option>
                  {draftProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.linkedContact}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("contactId", event.target.value)}
                  value={taskDraft.contactId}
                >
                  <option value="">{text.noContact}</option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.linkedLead}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("leadId", event.target.value)}
                  value={taskDraft.leadId}
                >
                  <option value="">{text.noLead}</option>
                  {leads.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {getCrmSystemTextLabel(lead.intent, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.owner}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateTaskDraft("ownerUserId", event.target.value)}
                  value={taskDraft.ownerUserId}
                >
                  <option value="">{text.noOwner}</option>
                  {team.users.some(user => user.id === sessionUserId) ? <option value={sessionUserId}>{selfOwnerName}</option> : null}
                  {assignableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
                {team.failed ? <button type="button" className="mt-2 block text-xs normal-case tracking-normal underline" onClick={team.retry}>{language === "de" ? "Teamauswahl erneut laden" : "Reload team options"}</button> : null}
              </label>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                className="w-full rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                disabled={
                  taskSaving ||
                  team.loading || team.failed || !team.users.some(user => user.id === taskDraft.ownerUserId) ||
                  !draftProjects.some((project) => project.id === taskDraft.projectId)
                }
                onClick={() => void createTask()}
                type="button"
              >
                {taskSaving ? text.savingTask : text.saveTask}
              </button>
              <button
                className="rounded-md border border-stone-300 px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-white"
                onClick={() => {
                  setTaskDraft(createDefaultTaskDraft(projects, sessionUserId, activeProjectId, timeZone));
                  setIsCreateOpen(false);
                }}
                type="button"
              >
                {text.cancel}
              </button>
            </div>
          </div>
        ) : null}
      </article>

      <section className="grid min-w-0 max-w-full gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h4 className="text-lg font-semibold">{text.recommendedQueue}</h4>
              <p className="mt-1 break-words text-sm text-stone-500">{text.queueReason}</p>
            </div>
            <label className="w-full text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 lg:w-80">
              {text.search}
              <input
                className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={text.searchPlaceholder}
                type="search"
                value={searchTerm}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {views.map((view) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  activeView === view.id ? viewStyles.active : viewStyles.idle
                }`}
                key={view.id}
                onClick={() => setActiveView(view.id)}
                type="button"
              >
                {view.label} · {view.count}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-stone-500">{language === "de" ? `Heute zeigt noch nicht überfällige Aufgaben. Überfällig umfasst auch frühere Uhrzeiten von heute. Zeitzone: ${timeZone}.` : `Today shows tasks that are not yet overdue. Overdue includes earlier times today. Timezone: ${timeZone}.`}</p>

          <div className="mt-5 grid gap-3">
            {filteredTasks.length > 0 ? (
              filteredTasks.map((item) => {
                const isSelected = selectedTask?.task.id === item.task.id;

                return (
                  <button
                    aria-pressed={isSelected}
                    className={`grid gap-3 rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-200 hover:bg-emerald-50"
                    }`}
                    key={item.task.id}
                    onClick={() => setSelectedTaskId(item.task.id)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span
                          className={`block break-words text-sm font-semibold ${
                            item.isCompleted ? "line-through opacity-70" : ""
                          }`}
                        >
                          {item.task.title}
                        </span>
                        <span
                          className={`mt-1 block break-words text-xs ${
                            isSelected ? "text-slate-300" : "text-stone-500"
                          }`}
                        >
                          {item.contact?.name ?? text.noContact} · {item.project?.name ?? item.task.project}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${
                          isSelected ? "border-white/10 bg-white/10 text-white" : priorityStyles[item.task.priority]
                        }`}
                      >
                        {getCrmTaskPriorityLabel(item.task.priority, language)}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-2 text-xs">
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        {formatTaskDue(item.task.due, language, timeZone, referenceNow)}
                      </span>
                      {item.lead ? (
                        <span
                          className={`rounded-md px-2 py-1 font-semibold ${
                            isSelected ? "bg-emerald-300/20 text-emerald-100" : "bg-emerald-50 text-emerald-800"
                          }`}
                        >
                          {text.score} {item.lead.score}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        {item.isCompleted ? text.done : text.open}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-500">
                {text.noTasks}
              </div>
            )}
          </div>
        </article>

        <aside className="min-w-0 rounded-lg border border-stone-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {text.nextTask}
          </p>
          <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {selectedTask?.task.title ?? text.noTasks}
          </h4>

          <div className="mt-4 grid gap-3 text-sm">
            {[
              [text.project, selectedTask?.project?.name ?? selectedTask?.task.project],
              [text.linkedContact, selectedTask?.contact?.name ?? text.noContact],
              [text.linkedLead, selectedTask?.leadIntentLabel ?? text.noLead],
              [text.descriptionField, selectedTask?.task.description],
              [text.source, selectedTask ? selectedTask.task.origin === "automation" ? "Automation" : (language === "de" ? "CRM-Aufgabe" : "CRM task") : undefined],
              [language === "de" ? "Kontaktquelle" : "Contact source", selectedTask?.contact?.source ? getCrmSourceLabel(selectedTask.contact.source, language) : undefined],
              [text.owner, selectedOwner ? selectedOwner.name || selectedOwner.email : text.noOwner],
              [text.due, selectedTask?.task.due ? formatTaskDue(selectedTask.task.due, language, timeZone, referenceNow) : undefined],
              [text.priority, selectedTask?.task.priority ? getCrmTaskPriorityLabel(selectedTask.task.priority, language) : undefined],
              [text.status, selectedTask ? getCrmTaskStatusLabel(selectedTask.isCompleted ? "done" : "open", language) : undefined],
            ].map(([label, value]) => (
              <div className="rounded-md bg-stone-50 p-3" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {label}
                </p>
                <p className="mt-1 break-words font-semibold text-slate-900">{value ?? "-"}</p>
              </div>
            ))}
          </div>

          <button
            className="mt-4 w-full rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white"
            disabled={!selectedTask || savingTaskIds.includes(selectedTask.task.id)}
            onClick={() => {
              if (selectedTask) {
                toggleTask(selectedTask.task.id);
              }
            }}
            type="button"
          >
            {selectedTask?.isCompleted ? text.reopen : text.markDone}
          </button>

          {selectedTask?.isCompleted ? <button type="button" className="mt-2 min-h-11 w-full rounded-md border border-emerald-300 px-4 py-2.5 text-sm font-semibold text-emerald-800" onClick={() => {
            const task = selectedTask.task;
            setTaskDraft({ ...createDefaultTaskDraft(projects, sessionUserId, task.projectId, timeZone), title: `${language === "de" ? "Nachfassen" : "Follow-up"}: ${task.title}`.slice(0, 180), contactId: task.contactId ?? "", leadId: task.leadId ?? "", ownerUserId: task.ownerUserId ?? sessionUserId });
            setIsCreateOpen(true);
            requestAnimationFrame(() => document.getElementById("task-create-form")?.scrollIntoView({ behavior: "smooth", block: "start" }));
          }}>{language === "de" ? "Folgeaufgabe anlegen" : "Create a follow-up task"}</button> : null}

          <button
            className="mt-2 w-full rounded-md border border-stone-300 px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!selectedTask || followUpSaving}
            onClick={() => {
              void prepareTaskFollowUp();
            }}
            type="button"
          >
            {followUpSaving ? text.savingFollowUp : text.prepareFollowUp}
          </button>

          {notice ? (
            <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
              {notice}
            </p>
          ) : null}

          <div className="mt-4 rounded-lg bg-slate-950 p-4 text-white">
            <p className="text-sm font-semibold">{text.taskReliability}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
                {selectedTask?.dueState.overdue ? text.overdue : text.due}
              </span>
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
                {selectedTask?.contact ? text.linkedContact : text.noContact}
              </span>
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
                {selectedTask?.project ? text.project : text.noProject}
              </span>
            </div>
          </div>

        </aside>
      </section>
    </section>
  );
}
