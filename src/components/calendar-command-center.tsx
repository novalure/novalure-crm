"use client";

import { useMemo, useState } from "react";
import type { CalendarEvent, Contact, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import { languageOptionsByCode, type LanguageCode } from "@/lib/i18n";

type CalendarCommandCenterProps = {
  contacts: Contact[];
  events: CalendarEvent[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
};

type CalendarView = "today" | "upcoming" | "prepare" | "teams" | "followUp";

const statusStyles = {
  geplant: "border-blue-200 bg-blue-50 text-blue-900",
  vorbereiten: "border-amber-200 bg-amber-50 text-amber-900",
  bestätigt: "border-emerald-200 bg-emerald-50 text-emerald-900",
  nachfassen: "border-red-200 bg-red-50 text-red-900",
} as const;

const labels = {
  de: {
    title: "Kalender und Microsoft 365",
    description:
      "Termine werden mit Projekt, Kontakt, Lead, Aufgabe und Teams-Link verbunden. So wird der Kalender später nicht nur Anzeige, sondern CRM-Arbeitsfläche.",
    today: "Heute",
    upcoming: "Nächste Termine",
    prepare: "Vorbereiten",
    teams: "Teams",
    followUp: "Nachfassen",
    search: "Suche",
    searchPlaceholder: "Termin, Kontakt, Projekt oder Vorbereitung suchen",
    selectedEvent: "Ausgewählter Termin",
    start: "Start",
    end: "Ende",
    location: "Ort",
    status: "Status",
    owner: "Verantwortlich",
    contact: "Kontakt",
    leadContext: "Lead-Kontext",
    project: "Projekt",
    outcomeGoal: "Ziel des Termins",
    preparation: "Vorbereitung",
    relatedTasks: "Passende Aufgaben",
    noTasks: "Keine offene Aufgabe zu diesem Termin.",
    noEvents: "Keine Termine für diese Ansicht.",
    noContact: "Kein Kontakt verknüpft",
    noLead: "Kein Lead verknüpft",
    teamsReady: "Teams-Link bereit",
    missingTeams: "Teams-Link fehlt",
    graphMapping: "Microsoft Graph Mapping",
    todayCount: "Termine heute",
    prepCount: "Vorbereitung nötig",
    teamsCount: "Teams-Termine",
    followUpCount: "Nachfass-Termine",
  },
  en: {
    title: "Calendar and Microsoft 365",
    description:
      "Appointments are linked with project, contact, lead, task and Teams join data. The calendar becomes a CRM workspace, not just a schedule.",
    today: "Today",
    upcoming: "Upcoming",
    prepare: "Prepare",
    teams: "Teams",
    followUp: "Follow up",
    search: "Search",
    searchPlaceholder: "Search appointment, contact, project or preparation",
    selectedEvent: "Selected appointment",
    start: "Start",
    end: "End",
    location: "Location",
    status: "Status",
    owner: "Owner",
    contact: "Contact",
    leadContext: "Lead context",
    project: "Project",
    outcomeGoal: "Appointment goal",
    preparation: "Preparation",
    relatedTasks: "Related tasks",
    noTasks: "No open task for this appointment.",
    noEvents: "No appointments for this view.",
    noContact: "No contact linked",
    noLead: "No lead linked",
    teamsReady: "Teams link ready",
    missingTeams: "Teams link missing",
    graphMapping: "Microsoft Graph mapping",
    todayCount: "Appointments today",
    prepCount: "Need preparation",
    teamsCount: "Teams meetings",
    followUpCount: "Follow-up meetings",
  },
} as const;

function isSameDay(value: string, day: Date) {
  const date = new Date(value);

  return (
    date.getFullYear() === day.getFullYear() &&
    date.getMonth() === day.getMonth() &&
    date.getDate() === day.getDate()
  );
}

function formatTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

export function CalendarCommandCenter({
  contacts,
  events,
  language,
  leads,
  projectLabel,
  projects,
  tasks,
  users,
}: CalendarCommandCenterProps) {
  const text = labels[language];
  const locale = languageOptionsByCode[language].locale;
  const today = new Date("2026-05-11T15:30:00+02:00");
  const [activeView, setActiveView] = useState<CalendarView>("today");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");

  const decoratedEvents = useMemo(
    () =>
      events
        .map((event) => {
          const contact = event.contactId
            ? contacts.find((item) => item.id === event.contactId)
            : undefined;
          const lead = event.leadId ? leads.find((item) => item.id === event.leadId) : undefined;
          const project = projects.find((item) => item.id === event.projectId);
          const owner = event.ownerUserId
            ? users.find((item) => item.id === event.ownerUserId)
            : undefined;

          return { event, contact, lead, owner, project };
        })
        .sort((a, b) => new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime()),
    [contacts, events, leads, projects, users],
  );

  const todayEvents = decoratedEvents.filter((item) => isSameDay(item.event.startsAt, today));
  const prepareEvents = decoratedEvents.filter((item) => item.event.status === "vorbereiten");
  const teamsEvents = decoratedEvents.filter((item) => item.event.location === "Teams");
  const followUpEvents = decoratedEvents.filter((item) => item.event.status === "nachfassen");
  const filteredEvents = decoratedEvents.filter((item) => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    const matchesView =
      (activeView === "today" && isSameDay(item.event.startsAt, today)) ||
      (activeView === "upcoming" && new Date(item.event.startsAt).getTime() >= today.getTime()) ||
      (activeView === "prepare" && item.event.status === "vorbereiten") ||
      (activeView === "teams" && item.event.location === "Teams") ||
      (activeView === "followUp" && item.event.status === "nachfassen");
    const searchable = [
      item.event.title,
      item.event.location,
      item.event.status,
      item.event.outcomeGoal,
      item.event.preparation.join(" "),
      item.contact?.name,
      item.lead?.intent,
      item.project?.name,
      item.owner?.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return matchesView && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
  const selectedEvent =
    decoratedEvents.find((item) => item.event.id === selectedEventId) ??
    filteredEvents[0] ??
    decoratedEvents[0];
  const selectedTasks = selectedEvent?.event.contactId
    ? tasks.filter(
        (task) => task.contactId === selectedEvent.event.contactId && task.status === "open",
      )
    : [];
  const views: Array<{ id: CalendarView; label: string; count: number }> = [
    { id: "today", label: text.today, count: todayEvents.length },
    { id: "upcoming", label: text.upcoming, count: decoratedEvents.length },
    { id: "prepare", label: text.prepare, count: prepareEvents.length },
    { id: "teams", label: text.teams, count: teamsEvents.length },
    { id: "followUp", label: text.followUp, count: followUpEvents.length },
  ];

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
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
              { label: text.todayCount, value: todayEvents.length },
              { label: text.prepCount, value: prepareEvents.length },
              { label: text.teamsCount, value: teamsEvents.length },
              { label: text.followUpCount, value: followUpEvents.length },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 p-3" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="break-words text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>
      </article>

      <section className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <article className="rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {views.map((view) => (
                <button
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    activeView === view.id
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
                  }`}
                  key={view.id}
                  onClick={() => setActiveView(view.id)}
                  type="button"
                >
                  {view.label} · {view.count}
                </button>
              ))}
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

          <div className="mt-5 grid gap-3">
            {filteredEvents.length > 0 ? (
              filteredEvents.map((item) => {
                const isSelected = selectedEvent?.event.id === item.event.id;

                return (
                  <button
                    aria-pressed={isSelected}
                    className={`grid gap-3 rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-200 hover:bg-emerald-50"
                    }`}
                    key={item.event.id}
                    onClick={() => setSelectedEventId(item.event.id)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold">
                          {item.event.title}
                        </span>
                        <span
                          className={`mt-1 block break-words text-xs ${
                            isSelected ? "text-slate-300" : "text-stone-500"
                          }`}
                        >
                          {formatDateTime(item.event.startsAt, locale)} ·{" "}
                          {item.contact?.name ?? text.noContact}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${
                          isSelected
                            ? "border-white/10 bg-white/10 text-white"
                            : statusStyles[item.event.status]
                        }`}
                      >
                        {item.event.status}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-2 text-xs">
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        {item.event.location}
                      </span>
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          item.event.teamsJoinUrl
                            ? isSelected
                              ? "bg-emerald-300/20 text-emerald-100"
                              : "bg-emerald-50 text-emerald-800"
                            : isSelected
                              ? "bg-white/10 text-white"
                              : "bg-amber-50 text-amber-800"
                        }`}
                      >
                        {item.event.teamsJoinUrl ? text.teamsReady : text.missingTeams}
                      </span>
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                        }`}
                      >
                        {item.project?.name ?? projectLabel}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-500">
                {text.noEvents}
              </div>
            )}
          </div>
        </article>

        <aside className="rounded-lg border border-stone-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {text.selectedEvent}
          </p>
          <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {selectedEvent?.event.title ?? text.noEvents}
          </h4>

          <div className="mt-4 grid gap-3 text-sm">
            {[
              [text.start, selectedEvent ? formatDateTime(selectedEvent.event.startsAt, locale) : "-"],
              [text.end, selectedEvent ? formatTime(selectedEvent.event.endsAt, locale) : "-"],
              [text.location, selectedEvent?.event.location],
              [text.status, selectedEvent?.event.status],
              [text.owner, selectedEvent?.owner?.name],
              [text.contact, selectedEvent?.contact?.name ?? text.noContact],
              [text.leadContext, selectedEvent?.lead?.intent ?? text.noLead],
              [text.project, selectedEvent?.project?.name ?? projectLabel],
            ].map(([label, value]) => (
              <div className="rounded-md bg-stone-50 p-3" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {label}
                </p>
                <p className="mt-1 break-words font-semibold text-slate-900">{value ?? "-"}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
            <p className="text-sm font-semibold">{text.outcomeGoal}</p>
            <p className="mt-2 break-words text-sm text-blue-900">
              {selectedEvent?.event.outcomeGoal ?? "-"}
            </p>
          </div>

          <div className="mt-4">
            <p className="text-sm font-semibold text-slate-950">{text.preparation}</p>
            <div className="mt-2 grid gap-2">
              {selectedEvent?.event.preparation.map((item) => (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm" key={item}>
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-950">{text.relatedTasks}</p>
              <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                {selectedTasks.length}
              </span>
            </div>
            <div className="mt-2 grid gap-2">
              {selectedTasks.length > 0 ? (
                selectedTasks.map((task) => (
                  <div className="rounded-md border border-stone-200 p-3 text-sm" key={task.id}>
                    <p className="break-words font-semibold text-slate-950">{task.title}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {task.due} · {task.priority}
                    </p>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-500">
                  {text.noTasks}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-slate-950 p-4 text-white">
            <p className="text-sm font-semibold">{text.graphMapping}</p>
            <div className="mt-3 grid gap-2 text-xs text-slate-200">
              <span>subject · {selectedEvent?.event.title ?? "-"}</span>
              <span>start.dateTime · {selectedEvent?.event.startsAt ?? "-"}</span>
              <span>end.dateTime · {selectedEvent?.event.endsAt ?? "-"}</span>
              <span>onlineMeeting.joinUrl · {selectedEvent?.event.teamsJoinUrl ? text.teamsReady : text.missingTeams}</span>
            </div>
          </div>
        </aside>
      </section>
    </section>
  );
}
