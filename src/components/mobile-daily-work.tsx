"use client";

import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, Contact, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import { analyzeSpeedToLead } from "@/lib/crm-analysis";
import {
  formatDateTime,
  formatNumber,
  getCrmSystemTextLabel,
  getCrmTaskDueLabel,
  getMobileDailyWorkCopy,
  type LanguageCode,
} from "@/lib/i18n";

type MobileDailySection = "leadInbox" | "tasks" | "calendar";
export type MobileDailyPanel = "overdueSla" | "hotLeads" | "meetings" | "tasks";

type MobileDailyWorkProps = {
  contacts: Contact[];
  events: CalendarEvent[];
  language: LanguageCode;
  leads: Lead[];
  onOpenSection: (section: MobileDailySection) => void;
  panels?: MobileDailyPanel[];
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
};

type MobileLeadItem = {
  contact?: Contact;
  lead: Lead;
  ownerName: string;
  projectName: string;
};

type MobileTaskItem = {
  contact?: Contact;
  lead?: Lead;
  projectName: string;
  task: Task;
};

type MobileEventItem = {
  contact?: Contact;
  event: CalendarEvent;
  projectName: string;
};

const cardClass = "rounded-lg border border-stone-200 bg-white p-4";
const actionBaseClass =
  "flex min-h-12 min-w-0 max-w-full items-center justify-center break-words rounded-md border px-3 py-2 text-center text-sm font-semibold whitespace-normal";
const actionButtonClass = `${actionBaseClass} border-stone-300 bg-white text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50`;
const primaryActionClass = `${actionBaseClass} border-slate-950 bg-slate-950 text-white hover:bg-slate-800`;
const defaultPanels: MobileDailyPanel[] = ["overdueSla", "hotLeads", "meetings", "tasks"];

function minutesUntil(value: string, nowMs: number | null) {
  if (nowMs === null) return null;
  const targetMs = new Date(value).getTime();
  return Number.isFinite(targetMs) ? Math.round((targetMs - nowMs) / 60000) : null;
}

function isToday(value: string, nowMs: number | null) {
  if (nowMs === null) return false;
  const date = new Date(value);
  const today = new Date(nowMs);

  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function taskDueRank(task: Task) {
  const parsed = new Date(task.due).getTime();
  if (Number.isFinite(parsed)) return Math.round(parsed / 60000);

  if (task.due.includes("Heute")) {
    const match = task.due.match(/(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 600;
  }

  if (task.due.includes("Morgen")) return 24 * 60;
  if (task.due.includes("Woche")) return 7 * 24 * 60;
  return 30 * 24 * 60;
}

function formatOverdueDuration(minutes: number | null, language: LanguageCode) {
  if (minutes === null) return "";
  const absoluteMinutes = Math.abs(minutes);
  if (absoluteMinutes >= 48 * 60) {
    const days = Math.round(absoluteMinutes / (24 * 60));
    return language === "de" ? `${days} Tg.` : `${days} d`;
  }

  if (absoluteMinutes >= 120) {
    const hours = Math.round(absoluteMinutes / 60);
    return language === "de" ? `${hours} Std.` : `${hours} h`;
  }

  return `${absoluteMinutes} min`;
}

function taskPriorityRank(task: Task) {
  if (task.priority === "Hoch") return 0;
  if (task.priority === "Mittel") return 1;
  return 2;
}

function getProjectName(projects: Project[], projectId: string, fallback: string) {
  return projects.find((project) => project.id === projectId)?.name ?? fallback;
}

function contactRoute(contact: Contact | undefined) {
  return {
    emailHref: contact?.email ? `mailto:${contact.email}` : "",
    phoneHref: contact?.phone ? `tel:${contact.phone.replace(/[^\d+]/g, "")}` : "",
  };
}

export function MobileDailyWork({
  contacts,
  events,
  language,
  leads,
  onOpenSection,
  panels = defaultPanels,
  projects,
  tasks,
  users,
}: MobileDailyWorkProps) {
  const text = getMobileDailyWorkCopy(language);
  const [completedTaskIds, setCompletedTaskIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [nowMs, setNowMs] = useState<number | null>(null);
  const visiblePanels = useMemo(() => new Set(panels), [panels]);

  useEffect(() => {
    const timer = window.setTimeout(() => setNowMs(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const hotLeadItems = useMemo<MobileLeadItem[]>(() => {
    return leads
      .filter((lead) => lead.status !== "Archiviert" && (lead.hotStatus || lead.score >= 80))
      .map((lead) => {
        const contact = contacts.find((item) => item.id === lead.contactId);
        const owner = users.find((user) => user.id === lead.assignedToUserId);

        return {
          contact,
          lead,
          ownerName: owner?.name ?? text.labels.noOwner,
          projectName: getProjectName(projects, lead.projectId, getCrmSystemTextLabel(lead.intent, language)),
        };
      })
      .sort((left, right) => right.lead.score - left.lead.score)
      .slice(0, 3);
  }, [contacts, language, leads, projects, text.labels.noOwner, users]);

  const overdueLeadItems = useMemo<MobileLeadItem[]>(() => {
    if (nowMs === null) return [];

    const overdueAlerts = analyzeSpeedToLead(leads, contacts, users, new Date(nowMs)).filter(
      (alert) => alert.state === "overdue",
    );

    return overdueAlerts
      .reduce<MobileLeadItem[]>((items, alert) => {
        const lead = leads.find((item) => item.id === alert.leadId);
        if (!lead) return items;

        const contact = contacts.find((item) => item.id === lead.contactId);

        items.push({
          contact,
          lead,
          ownerName: alert.ownerName || text.labels.noOwner,
          projectName: getProjectName(projects, lead.projectId, getCrmSystemTextLabel(lead.intent, language)),
        });

        return items;
      }, [])
      .slice(0, 3);
  }, [contacts, language, leads, nowMs, projects, text.labels.noOwner, users]);

  const todayEventItems = useMemo<MobileEventItem[]>(() => {
    return events
      .filter((event) => isToday(event.startsAt, nowMs))
      .map((event) => ({
        contact: event.contactId ? contacts.find((contact) => contact.id === event.contactId) : undefined,
        event,
        projectName: getProjectName(projects, event.projectId, event.title),
      }))
      .sort((left, right) => new Date(left.event.startsAt).getTime() - new Date(right.event.startsAt).getTime())
      .slice(0, 3);
  }, [contacts, events, nowMs, projects]);

  const openTaskItems = useMemo<MobileTaskItem[]>(() => {
    return tasks
      .filter((task) => task.status !== "done" && !completedTaskIds.includes(task.id))
      .map((task) => {
        const contact = task.contactId ? contacts.find((item) => item.id === task.contactId) : undefined;
        const lead = task.leadId ? leads.find((item) => item.id === task.leadId) : undefined;

        return {
          contact,
          lead,
          projectName: getProjectName(projects, task.projectId, task.project),
          task,
        };
      })
      .sort(
        (left, right) =>
          taskDueRank(left.task) - taskDueRank(right.task) ||
          taskPriorityRank(left.task) - taskPriorityRank(right.task) ||
          (right.lead?.score ?? 0) - (left.lead?.score ?? 0),
      )
      .slice(0, 4);
  }, [completedTaskIds, contacts, leads, projects, tasks]);

  const metrics = [
    { id: "hotLeads", label: text.metrics.hotLeads, value: hotLeadItems.length },
    { id: "overdueSla", label: text.metrics.overdueSla, value: overdueLeadItems.length },
    { id: "meetings", label: text.metrics.meetings, value: todayEventItems.length },
    { id: "tasks", label: text.metrics.tasks, value: openTaskItems.length },
  ].filter((metric) => visiblePanels.has(metric.id as MobileDailyPanel));

  async function prepareFollowUp(
    name: string,
    input: {
      contact?: Contact;
      lead?: Lead;
      projectId?: string;
      task?: Task;
    } = {},
  ) {
    setNotice(text.notices.followUp(name));

    await fetch("/api/crm/recommendation-runtime", {
      body: JSON.stringify({
        actionType: input.lead?.score && input.lead.score >= 80 ? "mobile_hot_lead_follow_up" : "mobile_follow_up",
        channel: input.contact?.email ? "E-Mail" : input.contact?.phone ? "WhatsApp" : "Telefon",
        contactId: input.contact?.id ?? null,
        email: input.contact?.email ?? null,
        leadId: input.lead?.id ?? input.task?.leadId ?? null,
        operation: "follow_up_action",
        outcome: "planned",
        phone: input.contact?.phone ?? null,
        projectId: input.projectId ?? input.lead?.projectId ?? input.task?.projectId ?? null,
        purpose: "salesFollowUp",
        taskTitle: input.task?.title ?? input.lead?.nextAction ?? text.actions.setFollowUp,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => undefined);

    onOpenSection("tasks");
  }

  function openMeeting() {
    setNotice(text.notices.meeting);
    onOpenSection("calendar");
  }

  function markTaskDone(task: Task) {
    setCompletedTaskIds((current) =>
      current.includes(task.id) ? current : [...current, task.id],
    );
    setNotice(text.notices.taskDone(task.title));

    void fetch("/api/crm/tasks", {
      body: JSON.stringify({ task: { ...task, status: "done" } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => undefined);
  }

  function renderContactActions(contact: Contact | undefined, name: string, lead?: Lead) {
    const route = contactRoute(contact);

    return (
      <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        {route.phoneHref ? (
          <a className={primaryActionClass} href={route.phoneHref}>
            {text.actions.call}
          </a>
        ) : (
          <button className={actionButtonClass} disabled type="button">
            {text.labels.noPhone}
          </button>
        )}
        {route.emailHref ? (
          <a className={actionButtonClass} href={route.emailHref}>
            {text.actions.email}
          </a>
        ) : (
          <button className={actionButtonClass} disabled type="button">
            {text.labels.noEmail}
          </button>
        )}
        <button className={actionButtonClass} onClick={openMeeting} type="button">
          {text.actions.meeting}
        </button>
        <button className={actionButtonClass} onClick={() => void prepareFollowUp(name, { contact, lead })} type="button">
          {text.actions.setFollowUp}
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4 md:hidden">
      <article className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
            {text.title}
          </p>
          <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {text.subtitle}
          </h3>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={metric.label}>
              <p className="text-2xl font-semibold text-slate-950">
                {formatNumber(metric.value, language)}
              </p>
              <p className="mt-1 break-words text-xs font-semibold text-stone-600">
                {metric.label}
              </p>
            </div>
          ))}
        </div>
        {notice ? (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
            {notice}
          </p>
        ) : null}
      </article>

      {visiblePanels.has("overdueSla") ? (
      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <h4 className="break-words text-base font-semibold text-slate-950">
            {text.sections.overdueSla}
          </h4>
          <button className="shrink-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => onOpenSection("leadInbox")} type="button">
            {text.metrics.overdueSla}
          </button>
        </div>
        <div className="mt-3 space-y-3">
          {overdueLeadItems.length > 0 ? (
            overdueLeadItems.map(({ contact, lead, ownerName, projectName }) => {
              const name = contact?.name ?? text.labels.unknownContact;
              const overdueLabel = formatOverdueDuration(minutesUntil(lead.slaDueAt, nowMs), language);

              return (
                <article className="rounded-md border border-rose-200 bg-rose-50 p-3" key={lead.id}>
                  <p className="break-words text-sm font-semibold text-slate-950">{name}</p>
                  <p className="mt-1 break-words text-xs text-stone-600">
                    {projectName} · {ownerName}{overdueLabel ? ` · ${overdueLabel}` : ""}
                  </p>
                  {renderContactActions(contact, name, lead)}
                </article>
              );
            })
          ) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
              {text.empty.overdueSla}
            </p>
          )}
        </div>
      </section>
      ) : null}

      {visiblePanels.has("hotLeads") ? (
      <section className={cardClass}>
        <h4 className="break-words text-base font-semibold text-slate-950">
          {text.sections.hotLeads}
        </h4>
        <div className="mt-3 space-y-3">
          {hotLeadItems.length > 0 ? (
            hotLeadItems.map(({ contact, lead, projectName }) => {
              const name = contact?.name ?? text.labels.unknownContact;

              return (
                <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={lead.id}>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-slate-950">{name}</p>
                      <p className="mt-1 break-words text-xs text-stone-600">
                        {projectName} · {getCrmSystemTextLabel(lead.intent, language)}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-slate-800">
                      {text.labels.score} {lead.score}
                    </span>
                  </div>
                  {renderContactActions(contact, name, lead)}
                </article>
              );
            })
          ) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
              {text.empty.hotLeads}
            </p>
          )}
        </div>
      </section>
      ) : null}

      {visiblePanels.has("meetings") ? (
      <section className={cardClass}>
        <h4 className="break-words text-base font-semibold text-slate-950">
          {text.sections.meetings}
        </h4>
        <div className="mt-3 space-y-3">
          {todayEventItems.length > 0 ? (
            todayEventItems.map(({ contact, event, projectName }) => {
              const route = contactRoute(contact);
              const meetingUrl = event.teamsJoinUrl || event.googleMeetJoinUrl;

              return (
                <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={event.id}>
                  <p className="break-words text-sm font-semibold text-slate-950">{event.title}</p>
                  <p className="mt-1 break-words text-xs text-stone-600">
                    {formatDateTime(event.startsAt, language)} · {projectName}
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                    {route.phoneHref ? (
                      <a className={actionButtonClass} href={route.phoneHref}>
                        {text.actions.call}
                      </a>
                    ) : (
                      <button className={actionButtonClass} disabled type="button">
                        {text.labels.noPhone}
                      </button>
                    )}
                    {route.emailHref ? (
                      <a className={actionButtonClass} href={route.emailHref}>
                        {text.actions.email}
                      </a>
                    ) : (
                      <button className={actionButtonClass} disabled type="button">
                        {text.labels.noEmail}
                      </button>
                    )}
                    {meetingUrl ? (
                      <a className={primaryActionClass} href={meetingUrl} rel="noreferrer" target="_blank">
                        {text.actions.meeting}
                      </a>
                    ) : (
                      <button className={primaryActionClass} onClick={openMeeting} type="button">
                        {text.actions.meeting}
                      </button>
                    )}
                    <button
                      className={actionButtonClass}
                      onClick={() => void prepareFollowUp(event.title, { contact, projectId: event.projectId })}
                      type="button"
                    >
                      {text.actions.setFollowUp}
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
              {text.empty.meetings}
            </p>
          )}
        </div>
      </section>
      ) : null}

      {visiblePanels.has("tasks") ? (
      <section className={cardClass}>
        <h4 className="break-words text-base font-semibold text-slate-950">
          {text.sections.tasks}
        </h4>
        <div className="mt-3 space-y-3">
          {openTaskItems.length > 0 ? (
            openTaskItems.map(({ contact, lead, projectName, task }) => {
              const name = contact?.name ?? (lead ? getCrmSystemTextLabel(lead.intent, language) : task.title);
              const route = contactRoute(contact);

              return (
                <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={task.id}>
                  <p className="break-words text-sm font-semibold text-slate-950">{task.title}</p>
                  <p className="mt-1 break-words text-xs text-stone-600">
                    {getCrmTaskDueLabel(task.due, language)} · {projectName}
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                    {route.phoneHref ? (
                      <a className={actionButtonClass} href={route.phoneHref}>
                        {text.actions.call}
                      </a>
                    ) : (
                      <button className={actionButtonClass} disabled type="button">
                        {text.labels.noPhone}
                      </button>
                    )}
                    {route.emailHref ? (
                      <a className={actionButtonClass} href={route.emailHref}>
                        {text.actions.email}
                      </a>
                    ) : (
                      <button className={actionButtonClass} disabled type="button">
                        {text.labels.noEmail}
                      </button>
                    )}
                    <button className={primaryActionClass} onClick={() => markTaskDone(task)} type="button">
                      {text.actions.taskDone}
                    </button>
                    <button
                      className={actionButtonClass}
                      onClick={() => void prepareFollowUp(name, { contact, lead, task })}
                      type="button"
                    >
                      {text.actions.setFollowUp}
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
              {text.empty.tasks}
            </p>
          )}
        </div>
      </section>
      ) : null}
    </section>
  );
}
