"use client";

import { useMemo } from "react";
import type { Contact, Deal, Project, PropertyReservation, PropertyUnit } from "@/lib/crm-types";
import { formatCurrency, formatDateTime, formatNumber, type LanguageCode } from "@/lib/i18n";

type ReservationBoardProps = {
  contacts: Contact[];
  deals: Deal[];
  language: LanguageCode;
  onOpenUnits: () => void;
  projectLabel: string;
  projects: Project[];
  reservations: PropertyReservation[];
  units: PropertyUnit[];
};

const text = {
  de: {
    active: "Aktive Reservierungen",
    buyer: "Käufer",
    deadline: "Reservierungsfrist",
    deposit: "Anzahlung",
    description: "Gefilterte Ansicht für reservierte Einheiten mit Fristen, Warnungen und Status.",
    empty: "Keine aktiven Reservierungen im aktuellen Projektfilter.",
    milestone: "Vertragsstand",
    nextAction: "Nächster Schritt",
    noBuyer: "Kein Kontakt",
    noDeal: "Kein Deal",
    noNextAction: "Kein nächster Schritt hinterlegt",
    openUnits: "Einheiten / Bestand",
    project: "Projekt",
    title: "Reservierungen",
    unit: "Einheit",
    metrics: {
      active: "Aktiv",
      warnings: "Fristwarnungen",
      units: "Reservierte Einheiten",
      deposit: "Anzahlungen",
    },
    status: {
      converted: "Umgewandelt",
      expired: "Abgelaufen",
      hold: "Hold",
      reserved: "Reserviert",
    },
    urgency: {
      closed: "Abgeschlossen",
      critical: "Laeuft bald ab",
      normal: "Im Zeitplan",
      overdue: "Frist ueberzogen",
      today: "Heute faellig",
      warning: "Frist beobachten",
    },
  },
  en: {
    active: "Active reservations",
    buyer: "Buyer",
    deadline: "Reservation deadline",
    deposit: "Deposit",
    description: "Filtered view for reserved units with deadlines, warnings and status.",
    empty: "No active reservations match the current project filter.",
    milestone: "Contract stage",
    nextAction: "Next action",
    noBuyer: "No contact",
    noDeal: "No deal",
    noNextAction: "No next action set",
    openUnits: "Units / inventory",
    project: "Project",
    title: "Reservations",
    unit: "Unit",
    metrics: {
      active: "Active",
      warnings: "Deadline warnings",
      units: "Reserved units",
      deposit: "Deposits",
    },
    status: {
      converted: "Converted",
      expired: "Expired",
      hold: "Hold",
      reserved: "Reserved",
    },
    urgency: {
      closed: "Closed",
      critical: "Expiring soon",
      normal: "On track",
      overdue: "Deadline missed",
      today: "Due today",
      warning: "Watch deadline",
    },
  },
} as const;

const milestoneLabels = {
  de: {
    contract_draft: "Vertragsentwurf",
    financing_check: "Finanzierungspruefung",
    not_started: "Nicht gestartet",
    offer_sent: "Angebot gesendet",
    signed: "Unterzeichnet",
  },
  en: {
    contract_draft: "Contract draft",
    financing_check: "Financing check",
    not_started: "Not started",
    offer_sent: "Offer sent",
    signed: "Signed",
  },
} as const;

const statusStyles: Record<PropertyReservation["status"], string> = {
  converted: "border-emerald-200 bg-emerald-50 text-emerald-900",
  expired: "border-rose-200 bg-rose-50 text-rose-900",
  hold: "border-amber-200 bg-amber-50 text-amber-900",
  reserved: "border-blue-200 bg-blue-50 text-blue-900",
};

const urgencyStyles = {
  closed: "border-stone-200 bg-stone-50 text-stone-700",
  critical: "border-rose-200 bg-rose-50 text-rose-900",
  normal: "border-emerald-200 bg-emerald-50 text-emerald-900",
  overdue: "border-red-300 bg-red-50 text-red-950",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
} as const;

function daysUntil(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function urgency(reservation: PropertyReservation, days: number | null): keyof typeof urgencyStyles {
  if (reservation.status === "converted" || reservation.status === "expired") return "closed";
  if (days === null) return "normal";
  if (days < 0) return "overdue";
  if (days <= 3) return "critical";
  if (days <= 7) return "warning";
  return "normal";
}

export function ReservationBoard({
  contacts,
  deals,
  language,
  onOpenUnits,
  projectLabel,
  projects,
  reservations,
  units,
}: ReservationBoardProps) {
  const copy = text[language];
  const views = useMemo(
    () =>
      reservations
        .map((reservation) => {
          const unit = units.find((item) => item.id === reservation.unitId);
          return {
            buyer: contacts.find((contact) => contact.id === reservation.contactId),
            days: daysUntil(reservation.expiresAt),
            deal: deals.find((deal) => deal.id === reservation.dealId),
            project: projects.find((project) => project.id === reservation.projectId),
            reservation,
            unit,
          };
        })
        .filter(({ reservation, unit }) =>
          reservation.status === "hold" || reservation.status === "reserved" || unit?.status === "reserved",
        )
        .sort((left, right) => (left.days ?? 9999) - (right.days ?? 9999)),
    [contacts, deals, projects, reservations, units],
  );
  const warningCount = views.filter((view) => ["critical", "overdue", "warning"].includes(urgency(view.reservation, view.days))).length;
  const unitCount = new Set(views.map((view) => view.unit?.id).filter(Boolean)).size;
  const depositTotal = views.reduce((sum, view) => sum + view.reservation.depositCents, 0);
  const metrics = [
    [copy.metrics.active, formatNumber(views.length, language)],
    [copy.metrics.units, formatNumber(unitCount, language)],
    [copy.metrics.warnings, formatNumber(warningCount, language)],
    [copy.metrics.deposit, formatCurrency(depositTotal / 100, language)],
  ];

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-950">{copy.title}</h3>
            <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{copy.description}</p>
          </div>
          <button className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50" onClick={onOpenUnits} type="button">
            {copy.openUnits}
          </button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(([label, value]) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={label}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h4 className="text-lg font-semibold text-slate-950">{copy.active}</h4>
          <p className="text-sm font-semibold text-stone-500">{formatNumber(views.length, language)}</p>
        </div>
        <div className="mt-4 grid gap-3">
          {views.length ? views.map((view) => {
            const level = urgency(view.reservation, view.days);
            const urgencyLabel = level === "critical" && view.days === 0 ? copy.urgency.today : copy.urgency[level];

            return (
              <div className="grid gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4 xl:grid-cols-[1.2fr_0.9fr_0.9fr_1fr]" key={view.reservation.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusStyles[view.reservation.status]}`}>{copy.status[view.reservation.status]}</span>
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${urgencyStyles[level]}`}>{urgencyLabel}</span>
                  </div>
                  <p className="mt-3 break-words text-base font-semibold text-slate-950">{copy.unit} {view.unit?.unitNumber ?? view.reservation.unitId}</p>
                  <p className="mt-1 break-words text-sm text-stone-600">{view.project?.name ?? copy.project}</p>
                </div>
                <div className="rounded-md bg-white p-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.deadline}</p>
                  <p className="mt-1 break-words font-semibold text-slate-900">{formatDateTime(view.reservation.expiresAt, language)}</p>
                  <p className="mt-1 text-xs font-semibold text-stone-500">{view.days === null ? "-" : `${Math.abs(view.days)} d`}</p>
                </div>
                <div className="rounded-md bg-white p-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.buyer}</p>
                  <p className="mt-1 break-words font-semibold text-slate-900">{view.buyer?.name ?? copy.noBuyer}</p>
                  <p className="mt-1 break-words text-xs font-semibold text-stone-500">{view.deal?.name ?? copy.noDeal}</p>
                </div>
                <div className="rounded-md bg-white p-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.nextAction}</p>
                  <p className="mt-1 break-words font-semibold text-slate-900">{view.reservation.nextAction || copy.noNextAction}</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
                    <span className="rounded-md bg-stone-100 px-2 py-1 text-stone-700">{milestoneLabels[language][view.reservation.contractMilestone]}</span>
                    <span className="rounded-md bg-stone-100 px-2 py-1 text-stone-700">{copy.deposit}: {formatCurrency(view.reservation.depositCents / 100, language)}</span>
                  </div>
                </div>
              </div>
            );
          }) : (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">{copy.empty}</div>
          )}
        </div>
      </article>
    </section>
  );
}
