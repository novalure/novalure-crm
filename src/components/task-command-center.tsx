"use client";

import { useMemo, useState } from "react";
import type { Contact, Lead, Project, Task } from "@/lib/crm-types";
import {
  getCrmSourceLabel,
  getCrmTaskDueLabel,
  getCrmTaskPriorityLabel,
  getCrmTaskStatusLabel,
  getTaskCommandCenterCopy,
  type LanguageCode,
} from "@/lib/i18n";

type TaskCommandCenterProps = {
  contacts: Contact[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
};

type TaskView = "focus" | "today" | "overdue" | "high" | "unlinked" | "followUp" | "all";

const priorityStyles = {
  Hoch: "border-red-200 bg-red-50 text-red-900",
  Mittel: "border-amber-200 bg-amber-50 text-amber-900",
  Normal: "border-stone-200 bg-stone-50 text-stone-700",
} as const;

const viewStyles = {
  active: "border-slate-950 bg-slate-950 text-white",
  idle: "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50",
};

function parseTaskDueDate(due: string, now = new Date()) {
  const normalized = due.trim().toLowerCase();
  const timeMatch = normalized.match(/(\d{1,2}):(\d{2})/);
  const hours = timeMatch ? Number(timeMatch[1]) : 23;
  const minutes = timeMatch ? Number(timeMatch[2]) : 59;

  if (normalized.includes("heute") || normalized.includes("today")) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  }

  if (normalized.includes("morgen") || normalized.includes("tomorrow")) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes, 0, 0);
  }

  if (normalized.includes("woche") || normalized.includes("week")) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 23, 59, 0, 0);
  }

  const parsed = new Date(due);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDueRank(due: string) {
  const parsed = parseTaskDueDate(due);
  return parsed ? Math.round(parsed.getTime() / 60000) : Number.MAX_SAFE_INTEGER;
}

function isDueToday(due: string) {
  const parsed = parseTaskDueDate(due);
  if (!parsed) return false;
  const today = new Date();

  return (
    parsed.getFullYear() === today.getFullYear() &&
    parsed.getMonth() === today.getMonth() &&
    parsed.getDate() === today.getDate()
  );
}

function isOverdue(due: string) {
  const parsed = parseTaskDueDate(due);
  return parsed ? parsed.getTime() < new Date().getTime() : false;
}

function getPriorityRank(priority: Task["priority"]) {
  if (priority === "Hoch") {
    return 0;
  }

  if (priority === "Mittel") {
    return 1;
  }

  return 2;
}

export function TaskCommandCenter({
  contacts,
  language,
  leads,
  projectLabel,
  projects,
  tasks,
}: TaskCommandCenterProps) {
  const text = getTaskCommandCenterCopy(language);
  const [activeView, setActiveView] = useState<TaskView>("focus");
  const [searchTerm, setSearchTerm] = useState("");
  const [completedTaskIds, setCompletedTaskIds] = useState<string[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? "");
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const decoratedTasks = useMemo(
    () =>
      tasks.map((task) => {
        const contact = task.contactId
          ? contacts.find((item) => item.id === task.contactId)
          : undefined;
        const lead = task.leadId ? leads.find((item) => item.id === task.leadId) : undefined;
        const project = projects.find((item) => item.id === task.projectId);
        const isCompleted = completedTaskIds.includes(task.id) || task.status === "done";

        return {
          task,
          contact,
          lead,
          project,
          isCompleted,
          rank:
            getDueRank(task.due) * 10 +
            getPriorityRank(task.priority) * 100 +
            (lead ? Math.max(0, 100 - lead.score) : 30),
        };
      }),
    [completedTaskIds, contacts, leads, projects, tasks],
  );

  const openTasks = decoratedTasks.filter((item) => !item.isCompleted);
  const dueTodayTasks = openTasks.filter((item) => isDueToday(item.task.due));
  const overdueTasks = openTasks.filter((item) => isOverdue(item.task.due));
  const highPriorityTasks = openTasks.filter((item) => item.task.priority === "Hoch");
  const followUpTasks = openTasks.filter((item) => Boolean(item.lead || item.contact));
  const unlinkedTasks = openTasks.filter((item) => !item.contact || !item.project);
  const filteredTasks = decoratedTasks
    .filter((item) => {
      const normalizedQuery = searchTerm.trim().toLowerCase();
      const matchesView =
        activeView === "all" ||
        (activeView === "focus" && !item.isCompleted) ||
        (activeView === "today" && !item.isCompleted && isDueToday(item.task.due)) ||
        (activeView === "overdue" && !item.isCompleted && isOverdue(item.task.due)) ||
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
        item.project?.type,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
    })
    .sort((a, b) => a.rank - b.rank);
  const selectedTask = decoratedTasks.find((item) => item.task.id === selectedTaskId) ??
    filteredTasks[0] ??
    decoratedTasks[0];
  const views: Array<{ id: TaskView; label: string; count: number }> = [
    { id: "focus", label: text.focus, count: openTasks.length },
    { id: "today", label: text.today, count: dueTodayTasks.length },
    { id: "overdue", label: text.overdue, count: overdueTasks.length },
    { id: "high", label: text.high, count: highPriorityTasks.length },
    { id: "unlinked", label: text.unlinked, count: unlinkedTasks.length },
    { id: "followUp", label: text.followUp, count: followUpTasks.length },
    { id: "all", label: text.all, count: decoratedTasks.length },
  ];

  const toggleTask = (taskId: string) => {
    const currentTask = decoratedTasks.find((item) => item.task.id === taskId);
    const nextStatus = currentTask?.isCompleted ? "open" : "done";

    setCompletedTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId],
    );

    if (currentTask) {
      void fetch("/api/crm/tasks", {
        body: JSON.stringify({ task: { ...currentTask.task, status: nextStatus } }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => undefined);
    }
  };

  const prepareTaskFollowUp = async () => {
    if (!selectedTask) return;

    setFollowUpSaving(true);
    try {
      const response = await fetch("/api/crm/recommendation-runtime", {
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
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
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
              { label: text.completedHere, value: completedTaskIds.length },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 p-3" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="break-words text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>
      </article>

      <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <article className="rounded-lg border border-stone-200 bg-white p-4">
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
                        {getCrmTaskDueLabel(item.task.due, language)}
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

        <aside className="rounded-lg border border-stone-200 bg-white p-5">
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
              [text.linkedLead, selectedTask?.lead?.intent ?? text.noLead],
              [text.source, selectedTask?.contact?.source ? getCrmSourceLabel(selectedTask.contact.source, language) : undefined],
              [text.due, selectedTask?.task.due ? getCrmTaskDueLabel(selectedTask.task.due, language) : undefined],
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
            disabled={!selectedTask}
            onClick={() => {
              if (selectedTask) {
                toggleTask(selectedTask.task.id);
              }
            }}
            type="button"
          >
            {selectedTask?.isCompleted ? text.reopen : text.markDone}
          </button>

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
                {selectedTask && isOverdue(selectedTask.task.due) ? text.overdue : text.due}
              </span>
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
                {selectedTask?.contact ? text.linkedContact : text.noContact}
              </span>
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
                {selectedTask?.project ? text.project : text.noProject}
              </span>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
            <p className="text-sm font-semibold">{text.microsoftReady}</p>
            <p className="mt-2 break-words text-sm text-blue-900">
              {selectedTask?.task.due ? getCrmTaskDueLabel(selectedTask.task.due, language) : "-"} · {selectedTask?.project?.name ?? projectLabel}
            </p>
          </div>
        </aside>
      </section>
    </section>
  );
}
