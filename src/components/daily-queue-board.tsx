"use client";

import { useMemo } from "react";
import type { CalendarEvent, Contact, DailyQueueActionSection, DailyQueueData, Lead, Project, Task } from "@/lib/crm-types";
import { formatDateTime, formatNumber, getCrmTaskDueLabel, getCrmTaskPriorityLabel, type LanguageCode } from "@/lib/i18n";

type DailyQueueSection = DailyQueueActionSection;

type DailyQueueBoardProps = {
  contacts: Contact[];
  dailyQueue?: DailyQueueData;
  events: CalendarEvent[];
  language: LanguageCode;
  leads: Lead[];
  onOpenSection: (section: DailyQueueSection) => void;
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
};

type DailyQueueItem = {
  actionLabel: string;
  actionSection: DailyQueueSection;
  id: string;
  kind: "hotLead" | "callback" | "meeting" | "overdueTask" | "task";
  meta: string[];
  priorityLabel: string;
  projectName: string;
  rank: number;
  title: string;
};

const text = {
  de: {
    callbacks: "Faellige Rueckrufe",
    description: "Fokussierte Heute-zuerst-Liste aus heissen Leads, faelligen Rueckrufen, heutigen Terminen und ueberfaelligen Aufgaben.",
    empty: "Die Tagesqueue ist leer. Es gibt aktuell keine heissen Leads, faelligen Rueckrufe, heutigen Termine oder ueberfaelligen Aufgaben im Projektfilter.",
    hotLeads: "Heisse Leads",
    meetings: "Heutige Termine",
    openCalendar: "Termine öffnen",
    openLeadInbox: "Lead-Zentrale öffnen",
    openTasks: "Aufgaben öffnen",
    overdueTasks: "Ueberfaellige Aufgaben",
    priority: "Prioritaet",
    projectFallback: "Projekt",
    sequenceTitle: "Heute zuerst",
    task: "Aufgabe",
    title: "Tagesqueue",
  },
  en: {
    callbacks: "Due callbacks",
    description: "Focused today-first list from hot leads, due callbacks, today's meetings and overdue tasks.",
    empty: "The daily queue is empty. No hot leads, due callbacks, meetings today or overdue tasks match the current project filter.",
    hotLeads: "Hot leads",
    meetings: "Today's meetings",
    openCalendar: "Open meetings",
    openLeadInbox: "Open lead inbox",
    openTasks: "Open tasks",
    overdueTasks: "Overdue tasks",
    priority: "Priority",
    projectFallback: "Project",
    sequenceTitle: "Today first",
    task: "Task",
    title: "Daily queue",
  },
} as const;

const kindStyles: Record<DailyQueueItem["kind"], string> = {
  callback: "border-blue-200 bg-blue-50 text-blue-900",
  hotLead: "border-emerald-200 bg-emerald-50 text-emerald-900",
  meeting: "border-violet-200 bg-violet-50 text-violet-900",
  overdueTask: "border-rose-200 bg-rose-50 text-rose-900",
  task: "border-amber-200 bg-amber-50 text-amber-900",
};

function compactStrings(items: Array<string | null | undefined>) {
  return items.filter((item): item is string => Boolean(item));
}

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

  const parsed = new Date(due);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSameDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function isTaskDueToday(task: Task) {
  const date = parseTaskDueDate(task.due);
  if (!date) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function isTaskOverdue(task: Task) {
  const date = parseTaskDueDate(task.due);
  return date ? date.getTime() < Date.now() : false;
}

function isCallbackTask(task: Task) {
  return /(rueckruf|ruckruf|callback|call|telefon|nachfass|follow-up|follow up)/i.test(task.title);
}

function taskPriorityRank(task: Task) {
  if (task.priority === "Hoch") return 0;
  if (task.priority === "Mittel") return 1;
  return 2;
}

function taskDueRank(task: Task) {
  const date = parseTaskDueDate(task.due);
  return date ? Math.round(date.getTime() / 60000) : Number.MAX_SAFE_INTEGER;
}

function getProjectName(projects: Project[], projectId: string, fallback: string) {
  return projects.find((project) => project.id === projectId)?.name ?? fallback;
}

export function DailyQueueBoard({
  contacts,
  dailyQueue,
  events,
  language,
  leads,
  onOpenSection,
  projectLabel,
  projects,
  tasks,
}: DailyQueueBoardProps) {
  const copy = text[language];
  const queueItems = useMemo<DailyQueueItem[]>(() => {
    const hotLeadItems = leads
      .filter((lead) => lead.status !== "Archiviert" && (lead.hotStatus || lead.score >= 80))
      .map<DailyQueueItem>((lead) => {
        const contact = contacts.find((item) => item.id === lead.contactId);
        return {
          actionLabel: copy.openLeadInbox,
          actionSection: "leadInbox",
          id: `lead:${lead.id}`,
          kind: "hotLead",
          meta: compactStrings([lead.intent, lead.nextAction, `Score ${lead.score}`]),
          priorityLabel: copy.hotLeads,
          projectName: getProjectName(projects, lead.projectId, lead.intent),
          rank: 10_000 - lead.score * 10,
          title: contact?.name ?? lead.intent,
        };
      });

    const taskItems = tasks
      .filter((task) => task.status !== "done")
      .map<DailyQueueItem | null>((task) => {
        const contact = task.contactId ? contacts.find((item) => item.id === task.contactId) : undefined;
        const callback = isCallbackTask(task);
        const overdue = isTaskOverdue(task);
        const dueToday = isTaskDueToday(task);
        if (!callback && !overdue && !dueToday && task.priority !== "Hoch") return null;

        const kind: DailyQueueItem["kind"] = overdue ? "overdueTask" : callback ? "callback" : "task";
        const baseRank = overdue ? 1_000 : callback ? 3_000 : 5_000;
        return {
          actionLabel: copy.openTasks,
          actionSection: "tasks",
          id: `task:${task.id}`,
          kind,
          meta: compactStrings([getCrmTaskDueLabel(task.due, language), contact?.name, getCrmTaskPriorityLabel(task.priority, language)]),
          priorityLabel: kind === "overdueTask" ? copy.overdueTasks : kind === "callback" ? copy.callbacks : copy.task,
          projectName: getProjectName(projects, task.projectId, task.project),
          rank: baseRank + taskPriorityRank(task) * 100 + taskDueRank(task) / 100_000,
          title: task.title,
        };
      })
      .filter((item): item is DailyQueueItem => Boolean(item));

    const meetingItems = events
      .filter((event) => isSameDay(event.startsAt))
      .map<DailyQueueItem>((event) => {
        const contact = event.contactId ? contacts.find((item) => item.id === event.contactId) : undefined;
        return {
          actionLabel: copy.openCalendar,
          actionSection: "calendar",
          id: `event:${event.id}`,
          kind: "meeting",
          meta: compactStrings([formatDateTime(event.startsAt, language), event.location, contact?.name]),
          priorityLabel: copy.meetings,
          projectName: getProjectName(projects, event.projectId, event.title),
          rank: 4_000 + new Date(event.startsAt).getTime() / 100_000_000,
          title: event.title,
        };
      });

    return [...taskItems, ...hotLeadItems, ...meetingItems].sort((left, right) => left.rank - right.rank).slice(0, 14);
  }, [contacts, copy, events, language, leads, projects, tasks]);

  const metrics: Array<[string, number, DailyQueueSection]> = [
    [copy.hotLeads, queueItems.filter((item) => item.kind === "hotLead").length, "leadInbox" as const],
    [copy.callbacks, queueItems.filter((item) => item.kind === "callback").length, "tasks" as const],
    [copy.meetings, queueItems.filter((item) => item.kind === "meeting").length, "calendar" as const],
    [copy.overdueTasks, queueItems.filter((item) => item.kind === "overdueTask").length, "tasks" as const],
  ];

  if (dailyQueue?.sections?.length) {
    const serverMetrics = dailyQueue.sections.map((section) => [
      section.title[language],
      section.cards.length,
      section.cards[0]?.actionSection ?? "leadInbox",
    ] as [string, number, DailyQueueSection]);

    return (
      <section className="grid gap-4">
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
              <h3 className="mt-1 text-2xl font-semibold text-slate-950">{copy.title}</h3>
              <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{copy.description}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
              {serverMetrics.map(([label, value]) => (
                <div className="rounded-md bg-stone-50 p-3" key={label}>
                  <p className="font-semibold">{formatNumber(value, language)}</p>
                  <p className="break-words text-xs text-stone-500">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </article>

        <section className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <div className="grid gap-4">
            {dailyQueue.sections.map((section) => (
              <article className="rounded-lg border border-stone-200 bg-white p-5" key={section.id}>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <h4 className="text-lg font-semibold text-slate-950">{section.title[language]}</h4>
                  <p className="text-sm font-semibold text-stone-500">{formatNumber(section.cards.length, language)}</p>
                </div>
                <div className="mt-4 grid gap-3">
                  {section.cards.length ? section.cards.map((item, index) => (
                    <div className="grid gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4 lg:grid-cols-[48px_1fr_auto]" key={item.id}>
                      <div className="grid h-12 w-12 place-items-center rounded-md bg-white text-sm font-semibold text-slate-950">{index + 1}</div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-900">{item.stage}</span>
                          <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{item.source}</span>
                          <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{formatNumber(item.daysInStage, language)} d</span>
                          <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{item.owner}</span>
                        </div>
                        <h5 className="mt-3 break-words text-base font-semibold text-slate-950">{item.title}</h5>
                        <p className="mt-2 break-words text-sm font-semibold text-stone-700">{item.nextAction}</p>
                      </div>
                      <button className="h-10 rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-stone-100" onClick={() => onOpenSection(item.actionSection)} type="button">{item.actionLabel}</button>
                    </div>
                  )) : (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">{section.emptyText[language]}</div>
                  )}
                </div>
              </article>
            ))}
          </div>

          <aside className="rounded-lg border border-stone-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{copy.priority}</p>
            <div className="mt-4 grid gap-3">
              {serverMetrics.map(([label, value, section]) => (
                <button className="rounded-md border border-stone-200 bg-stone-50 p-3 text-left text-sm hover:border-emerald-200 hover:bg-emerald-50" key={label} onClick={() => onOpenSection(section)} type="button">
                  <span className="block font-semibold text-slate-950">{label}</span>
                  <span className="mt-1 block text-xs font-semibold text-stone-500">{formatNumber(value, language)}</span>
                </button>
              ))}
            </div>
          </aside>
        </section>
      </section>
    );
  }

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-950">{copy.title}</h3>
            <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{copy.description}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {metrics.map(([label, value]) => (
              <div className="rounded-md bg-stone-50 p-3" key={label}>
                <p className="font-semibold">{formatNumber(value, language)}</p>
                <p className="break-words text-xs text-stone-500">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </article>

      <section className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h4 className="text-lg font-semibold text-slate-950">{copy.sequenceTitle}</h4>
            <p className="text-sm font-semibold text-stone-500">{formatNumber(queueItems.length, language)}</p>
          </div>
          <div className="mt-4 grid gap-3">
            {queueItems.length ? queueItems.map((item, index) => (
              <div className="grid gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4 lg:grid-cols-[48px_1fr_auto]" key={item.id}>
                <div className="grid h-12 w-12 place-items-center rounded-md bg-white text-sm font-semibold text-slate-950">{index + 1}</div>
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${kindStyles[item.kind]}`}>{item.priorityLabel}</span>
                    <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{item.projectName || copy.projectFallback}</span>
                  </div>
                  <h5 className="mt-3 break-words text-base font-semibold text-slate-950">{item.title}</h5>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold text-stone-600">
                    {item.meta.map((meta) => <span className="rounded-md bg-white px-2 py-1" key={meta}>{meta}</span>)}
                  </div>
                </div>
                <button className="h-10 rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-stone-100" onClick={() => onOpenSection(item.actionSection)} type="button">{item.actionLabel}</button>
              </div>
            )) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">{copy.empty}</div>
            )}
          </div>
        </article>

        <aside className="rounded-lg border border-stone-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{copy.priority}</p>
          <div className="mt-4 grid gap-3">
            {metrics.map(([label, value, section]) => (
              <button className="rounded-md border border-stone-200 bg-stone-50 p-3 text-left text-sm hover:border-emerald-200 hover:bg-emerald-50" key={label} onClick={() => onOpenSection(section)} type="button">
                <span className="block font-semibold text-slate-950">{label}</span>
                <span className="mt-1 block text-xs font-semibold text-stone-500">{formatNumber(value, language)}</span>
              </button>
            ))}
          </div>
        </aside>
      </section>
    </section>
  );
}
