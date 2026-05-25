"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  Contact,
  Deal,
  Lead,
  Project,
  PropertyBuilding,
  PropertyReservation,
  PropertyUnit,
} from "@/lib/crm-types";
import {
  formatCurrency,
  formatNumber,
  getLocale,
  getUnitBoardCopy,
  type LanguageCode,
} from "@/lib/i18n";

type UnitBoardProps = {
  buildings: PropertyBuilding[];
  contacts: Contact[];
  deals: Deal[];
  initialProjectId?: string;
  language: LanguageCode;
  leads: Lead[];
  onReservationChanged?: () => Promise<void> | void;
  projectLabel: string;
  projects: Project[];
  reservations: PropertyReservation[];
  units: PropertyUnit[];
};

type UnitStatusFilter = PropertyUnit["status"] | "all";
type RoomFilter = "all" | string;
type ReservationWorkflowAction = "create" | "extend" | "expire" | "convert";

type UnitBoardView = {
  building?: PropertyBuilding;
  buyer?: Contact;
  buyerMatches: BuyerMatch[];
  deal?: Deal;
  project?: Project;
  reservation?: PropertyReservation;
  unit: PropertyUnit;
};

type BuyerMatch = {
  contact?: Contact;
  lead: Lead;
  reasons: string[];
  score: number;
};

type WorkflowDraft = {
  action: ReservationWorkflowAction;
  contactId: string;
  contractMilestone: string;
  createTask: boolean;
  dealId: string;
  deposit: string;
  expiresAt: string;
  nextAction: string;
  notifyTeams: boolean;
  reservationId: string;
  unitId: string;
};

type WorkflowNotice = {
  kind: "success" | "error";
  message: string;
};

type InventoryMode = "building" | "unit" | null;

type InventoryDraft = {
  address: string;
  areaSqm: string;
  buildingId: string;
  floor: string;
  floors: string;
  name: string;
  price: string;
  projectId: string;
  rooms: string;
  unitNumber: string;
};

const statusStyles: Record<PropertyUnit["status"], string> = {
  available: "border-emerald-200 bg-emerald-50 text-emerald-900",
  blocked: "border-slate-300 bg-slate-100 text-slate-800",
  reserved: "border-amber-200 bg-amber-50 text-amber-900",
  sold: "border-blue-200 bg-blue-50 text-blue-900",
};

const reservationStyles: Record<PropertyReservation["status"], string> = {
  converted: "border-emerald-200 bg-emerald-50 text-emerald-900",
  expired: "border-rose-200 bg-rose-50 text-rose-900",
  hold: "border-amber-200 bg-amber-50 text-amber-900",
  reserved: "border-blue-200 bg-blue-50 text-blue-900",
};

const workflowActions: ReservationWorkflowAction[] = ["create", "extend", "expire", "convert"];

function Pill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={`inline-flex max-w-full rounded-md border px-2 py-1 text-xs font-semibold leading-snug ${className}`}>
      {children}
    </span>
  );
}

function parsePrice(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function parseBudgetText(value: string | undefined) {
  if (!value) return null;

  const hasMillionUnit = /mio\.?/i.test(value);
  const numbers = value
    .match(/\d[\d.,]*/g)
    ?.map((item) => Number(item.replace(/\./g, "").replace(",", ".")))
    .filter((item) => Number.isFinite(item) && item > 0);

  if (!numbers?.length) return null;

  const normalized = numbers.map((item) => {
    if (hasMillionUnit && item < 100) return item * 1_000_000;
    return item < 10_000 ? item * 1000 : item;
  });
  return {
    from: Math.min(...normalized),
    to: Math.max(...normalized),
  };
}

function formatDate(value: string, language: LanguageCode) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(getLocale(language), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function daysUntil(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function defaultReservationDeadline() {
  return new Date(Date.now() + 7 * 86_400_000).toISOString();
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDepositCents(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function isActiveReservation(reservation?: PropertyReservation) {
  return reservation?.status === "hold" || reservation?.status === "reserved";
}

function findReservation(unit: PropertyUnit, reservations: PropertyReservation[]) {
  const directReservation = unit.reservationId
    ? reservations.find((reservation) => reservation.id === unit.reservationId)
    : undefined;

  if (directReservation) return directReservation;

  return reservations
    .filter((reservation) => reservation.unitId === unit.id)
    .sort((left, right) => new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime())[0];
}

function getBuyerMatches(
  unit: PropertyUnit,
  leads: Lead[],
  contacts: Contact[],
  text: ReturnType<typeof getUnitBoardCopy>,
): BuyerMatch[] {
  if (unit.status !== "available") return [];

  return leads
    .filter((lead) =>
      lead.projectId === unit.projectId &&
      lead.status !== "Archiviert" &&
      (lead.type === "Käufer" || lead.type === "Investor"),
    )
    .map((lead) => {
      const contact = contacts.find((item) => item.id === lead.contactId);
      const budget = lead.buyerProfile
        ? { from: lead.buyerProfile.budgetFrom, to: lead.buyerProfile.budgetTo }
        : lead.investorProfile
          ? {
              from: lead.investorProfile.investmentVolumeFrom,
              to: lead.investorProfile.investmentVolumeTo,
            }
          : parseBudgetText(lead.budget);
      const unitPrice = unit.priceCents / 100;
      const reasons: string[] = [];
      let score = lead.score ? Math.min(20, Math.round(lead.score / 5)) : 0;

      if (budget) {
        if (budget.from <= unitPrice && budget.to >= unitPrice) {
          score += 45;
          reasons.push(text.matchReasonBudget);
        } else if (budget.to >= unitPrice * 0.9 && budget.to <= unitPrice * 1.15) {
          score += 25;
          reasons.push(text.matchReasonBudget);
        }
      }

      if (lead.rooms && Math.abs(lead.rooms - unit.rooms) <= 1) {
        score += 15;
        reasons.push(text.matchReasonRooms);
      }

      if (lead.areaSqm && Math.abs(lead.areaSqm - unit.areaSqm) <= Math.max(8, unit.areaSqm * 0.15)) {
        score += 10;
        reasons.push(text.matchReasonArea);
      }

      if (lead.hotStatus) {
        score += 10;
        reasons.push(text.matchReasonHot);
      }

      return {
        contact,
        lead,
        reasons,
        score: Math.min(100, score),
      };
    })
    .filter((match) => match.score >= 35)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

export function UnitBoard({
  buildings,
  contacts,
  deals,
  initialProjectId = "all",
  language,
  leads,
  onReservationChanged,
  projectLabel,
  projects,
  reservations,
  units,
}: UnitBoardProps) {
  const text = getUnitBoardCopy(language);
  const [statusFilter, setStatusFilter] = useState<UnitStatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState(initialProjectId || "all");
  const [buildingFilter, setBuildingFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [roomFilter, setRoomFilter] = useState<RoomFilter>("all");
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null);
  const [workflowNotice, setWorkflowNotice] = useState<WorkflowNotice | null>(null);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [runtimeBusyKey, setRuntimeBusyKey] = useState("");
  const [runtimeNotice, setRuntimeNotice] = useState<WorkflowNotice | null>(null);
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>(null);
  const [inventoryDraft, setInventoryDraft] = useState<InventoryDraft>(() => ({
    address: "",
    areaSqm: "",
    buildingId: "",
    floor: "",
    floors: "",
    name: "",
    price: "",
    projectId: initialProjectId !== "all" ? initialProjectId : projects[0]?.id ?? "",
    rooms: "",
    unitNumber: "",
  }));
  const [inventoryNotice, setInventoryNotice] = useState<WorkflowNotice | null>(null);
  const [inventorySaving, setInventorySaving] = useState(false);

  const projectOptions = useMemo(
    () => projects,
    [projects],
  );
  const filteredBuildings = useMemo(
    () =>
      buildings.filter((building) =>
        projectFilter === "all" ? units.some((unit) => unit.buildingId === building.id) : building.projectId === projectFilter,
      ),
    [buildings, projectFilter, units],
  );
  const roomOptions = useMemo(
    () => Array.from(new Set(units.map((unit) => unit.rooms))).sort((left, right) => left - right),
    [units],
  );
  const minPriceCents = parsePrice(minPrice);
  const maxPriceCents = parsePrice(maxPrice);

  const unitViews = useMemo<UnitBoardView[]>(
    () =>
      units
        .map((unit) => {
          const reservation = findReservation(unit, reservations);
          const buyer = contacts.find((contact) => contact.id === (unit.buyerContactId ?? reservation?.contactId));
          const deal = deals.find((item) => item.id === (unit.dealId ?? reservation?.dealId));
          const building = buildings.find((item) => item.id === unit.buildingId);
          const project = projects.find((item) => item.id === unit.projectId);
          const buyerMatches = getBuyerMatches(unit, leads, contacts, text);

          return { building, buyer, buyerMatches, deal, project, reservation, unit };
        })
        .filter(({ unit }) => projectFilter === "all" || unit.projectId === projectFilter)
        .filter(({ unit }) => buildingFilter === "all" || unit.buildingId === buildingFilter)
        .filter(({ unit }) => statusFilter === "all" || unit.status === statusFilter)
        .filter(({ unit }) => roomFilter === "all" || String(unit.rooms) === roomFilter)
        .filter(({ unit }) => minPriceCents === null || unit.priceCents >= minPriceCents)
        .filter(({ unit }) => maxPriceCents === null || unit.priceCents <= maxPriceCents)
        .sort((left, right) => {
          const projectCompare = (left.project?.name ?? "").localeCompare(right.project?.name ?? "");
          if (projectCompare !== 0) return projectCompare;
          const buildingCompare = (left.building?.name ?? "").localeCompare(right.building?.name ?? "");
          if (buildingCompare !== 0) return buildingCompare;
          return left.unit.unitNumber.localeCompare(right.unit.unitNumber, undefined, { numeric: true });
        }),
    [
      buildingFilter,
      buildings,
      contacts,
      deals,
      leads,
      maxPriceCents,
      minPriceCents,
      projectFilter,
      projects,
      reservations,
      roomFilter,
      statusFilter,
      text,
      units,
    ],
  );

  const activeUnitIds = new Set(unitViews.map(({ unit }) => unit.id));
  const visibleUnits = unitViews.map(({ unit }) => unit);
  const inventoryValue = visibleUnits.reduce((sum, unit) => sum + unit.priceCents, 0);
  const soldValue = visibleUnits
    .filter((unit) => unit.status === "sold")
    .reduce((sum, unit) => sum + unit.priceCents, 0);
  const totalAreaSqm = visibleUnits.reduce((sum, unit) => sum + unit.areaSqm, 0);
  const averagePricePerSqm = totalAreaSqm > 0 ? inventoryValue / 100 / totalAreaSqm : 0;
  const availableCount = visibleUnits.filter((unit) => unit.status === "available").length;
  const reservedCount = visibleUnits.filter((unit) => unit.status === "reserved").length;
  const soldCount = visibleUnits.filter((unit) => unit.status === "sold").length;
  const blockedViews = unitViews.filter(({ unit }) => unit.status === "blocked");
  const expiringReservations = reservations
    .map((reservation) => ({
      days: daysUntil(reservation.expiresAt),
      reservation,
      unit: units.find((unit) => unit.id === reservation.unitId),
    }))
    .filter(
      (item) =>
        item.unit &&
        activeUnitIds.has(item.unit.id) &&
        item.days !== null &&
        item.days <= 7 &&
        item.reservation.status !== "converted" &&
        item.reservation.status !== "expired",
    )
    .sort((left, right) => (left.days ?? 0) - (right.days ?? 0));

  const metrics = [
    { label: text.totalUnits, value: formatNumber(visibleUnits.length, language) },
    { label: text.availableUnits, value: formatNumber(availableCount, language) },
    { label: text.reservedUnits, value: formatNumber(reservedCount, language) },
    { label: text.blockedUnits, value: formatNumber(blockedViews.length, language) },
    { label: text.soldUnits, value: formatNumber(soldCount, language) },
    { label: text.buyerMatches, value: formatNumber(unitViews.filter((view) => view.buyerMatches.length > 0).length, language) },
    { label: text.inventoryValue, value: formatCurrency(inventoryValue / 100, language) },
  ];
  const managementMetrics = [
    {
      label: text.availableShare,
      value: visibleUnits.length ? `${formatNumber(Math.round((availableCount / visibleUnits.length) * 100), language)}%` : "0%",
    },
    {
      label: text.reservationShare,
      value: visibleUnits.length ? `${formatNumber(Math.round((reservedCount / visibleUnits.length) * 100), language)}%` : "0%",
    },
    {
      label: text.soldShare,
      value: visibleUnits.length ? `${formatNumber(Math.round((soldCount / visibleUnits.length) * 100), language)}%` : "0%",
    },
    { label: text.soldValue, value: formatCurrency(soldValue / 100, language) },
    { label: text.averagePricePerSqm, value: formatCurrency(averagePricePerSqm, language) },
    { label: text.warningCount, value: formatNumber(expiringReservations.length, language) },
  ];

  const selectedView = workflowDraft ? unitViews.find(({ unit }) => unit.id === workflowDraft.unitId) : undefined;
  const selectedContacts = selectedView ? contacts.filter((contact) => contact.projectId === selectedView.unit.projectId) : [];
  const selectedDeals = selectedView ? deals.filter((deal) => deal.projectId === selectedView.unit.projectId) : [];
  const selectedHasActiveReservation = isActiveReservation(selectedView?.reservation);
  const milestoneOptions = Object.entries(text.contractMilestoneLabels);
  const canSaveWorkflow = Boolean(
    workflowDraft &&
      selectedView &&
      workflowDraft.contactId &&
      workflowDraft.expiresAt &&
      (workflowDraft.action === "create" ? selectedView.unit.status === "available" && !selectedHasActiveReservation : selectedHasActiveReservation),
  );

  function resetFilters() {
    setStatusFilter("all");
    setProjectFilter(initialProjectId || "all");
    setBuildingFilter("all");
    setMinPrice("");
    setMaxPrice("");
    setRoomFilter("all");
  }

  function workflowActionLabel(action: ReservationWorkflowAction) {
    if (action === "create") return text.reserveAction;
    if (action === "extend") return text.extendAction;
    if (action === "expire") return text.expireAction;
    return text.convertAction;
  }

  function openWorkflow(view: UnitBoardView, action: ReservationWorkflowAction) {
    const reservation = view.reservation;
    setWorkflowNotice(null);
    setWorkflowDraft({
      action,
      contactId: view.buyer?.id ?? reservation?.contactId ?? "",
      contractMilestone: reservation?.contractMilestone || "not_started",
      createTask: true,
      dealId: view.deal?.id ?? reservation?.dealId ?? "",
      deposit: reservation?.depositCents ? String(reservation.depositCents / 100) : "",
      expiresAt: toDateTimeLocal(reservation?.expiresAt ?? defaultReservationDeadline()),
      nextAction: reservation?.nextAction ?? "",
      notifyTeams: false,
      reservationId: reservation?.id ?? "",
      unitId: view.unit.id,
    });
  }

  function openInventory(mode: Exclude<InventoryMode, null>) {
    const projectId = projectFilter !== "all" ? projectFilter : projects[0]?.id ?? "";
    const buildingId = buildings.find((building) => building.projectId === projectId)?.id ?? "";
    setInventoryNotice(null);
    setInventoryMode(mode);
    setInventoryDraft((current) => ({
      ...current,
      buildingId,
      projectId,
    }));
  }

  function updateInventoryDraft<Key extends keyof InventoryDraft>(key: Key, value: InventoryDraft[Key]) {
    setInventoryDraft((current) => ({ ...current, [key]: value }));
  }

  async function submitInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inventoryMode || !inventoryDraft.projectId) return;

    setInventorySaving(true);
    setInventoryNotice(null);

    try {
      const response = await fetch("/api/crm/units", {
        body: JSON.stringify({
          operation: inventoryMode,
          ...inventoryDraft,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({ error: text.inventorySaveFailed }));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : text.inventorySaveFailed);
      }

      setInventoryNotice({ kind: "success", message: text.inventorySaved });
      setInventoryMode(null);
      await onReservationChanged?.();
    } catch (error) {
      setInventoryNotice({
        kind: "error",
        message: error instanceof Error ? error.message : text.inventorySaveFailed,
      });
    } finally {
      setInventorySaving(false);
    }
  }

  function updateWorkflowDraft<Key extends keyof WorkflowDraft>(key: Key, value: WorkflowDraft[Key]) {
    setWorkflowDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function postRuntimeWorkflow(key: string, payload: Record<string, unknown>, successMessage: string) {
    setRuntimeBusyKey(key);
    setRuntimeNotice(null);

    try {
      const response = await fetch("/api/crm/recommendation-runtime", {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({ error: text.workflowFailed }));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : text.workflowFailed);
      }

      await onReservationChanged?.();
      setRuntimeNotice({ kind: "success", message: successMessage });
    } catch (error) {
      setRuntimeNotice({
        kind: "error",
        message: error instanceof Error ? error.message : text.workflowFailed,
      });
    } finally {
      setRuntimeBusyKey("");
    }
  }

  function createViewingSlot(view: UnitBoardView) {
    const matchLead = view.buyerMatches[0]?.lead;
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(new Date(startsAt).getTime() + 45 * 60 * 1000).toISOString();

    return postRuntimeWorkflow(
      `viewing:${view.unit.id}`,
      {
        contactId: view.buyer?.id ?? matchLead?.contactId ?? null,
        dealId: view.deal?.id ?? null,
        endsAt,
        leadId: matchLead?.id ?? null,
        note: `${text.viewingSlotAction}: ${view.unit.unitNumber}`,
        operation: "viewing_slot",
        startsAt,
        status: "planned",
        unitId: view.unit.id,
      },
      text.viewingSlotSaved,
    );
  }

  function createOfferMilestone(view: UnitBoardView) {
    return postRuntimeWorkflow(
      `offer:${view.unit.id}`,
      {
        contactId: view.buyer?.id ?? view.reservation?.contactId ?? null,
        dealId: view.deal?.id ?? view.reservation?.dealId ?? null,
        dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        milestone: "offer_created",
        operation: "offer_milestone",
        reservationId: view.reservation?.id ?? null,
        status: "open",
        unitId: view.unit.id,
      },
      text.offerMilestoneSaved,
    );
  }

  function markOfferLost(view: UnitBoardView) {
    return postRuntimeWorkflow(
      `offer-lost:${view.unit.id}`,
      {
        contactId: view.buyer?.id ?? view.reservation?.contactId ?? null,
        dealId: view.deal?.id ?? view.reservation?.dealId ?? null,
        metadata: { reasonCategory: "other" },
        milestone: "lost",
        operation: "offer_milestone",
        reason: text.offerLostReason,
        reservationId: view.reservation?.id ?? null,
        status: "lost",
        unitId: view.unit.id,
      },
      text.offerLostSaved,
    );
  }

  function createUnitAudit(view: UnitBoardView) {
    return postRuntimeWorkflow(
      `audit:${view.unit.id}`,
      {
        after: {
          priceCents: view.unit.priceCents,
          status: view.unit.status,
        },
        before: {
          priceCents: view.unit.priceCents,
          status: view.unit.status,
        },
        eventType: view.unit.status === "blocked" ? "block_review" : "price_review",
        operation: "unit_audit",
        reason: text.unitAuditReason,
        unitId: view.unit.id,
      },
      text.unitAuditSaved,
    );
  }

  async function submitReservationWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflowDraft || !selectedView || !canSaveWorkflow) {
      return;
    }

    setWorkflowSaving(true);
    setWorkflowNotice(null);

    try {
      const response = await fetch("/api/crm/reservations", {
        body: JSON.stringify({
          action: workflowDraft.action,
          contactId: workflowDraft.contactId,
          contractMilestone: workflowDraft.contractMilestone,
          createTask: workflowDraft.createTask,
          dealId: workflowDraft.dealId || null,
          depositCents: parseDepositCents(workflowDraft.deposit),
          expiresAt: fromDateTimeLocal(workflowDraft.expiresAt),
          nextAction: workflowDraft.nextAction,
          notifyTeams: workflowDraft.notifyTeams,
          reservationId: workflowDraft.reservationId || selectedView.reservation?.id || null,
          unitId: workflowDraft.unitId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({ error: text.workflowFailed }));
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : text.workflowFailed;
        throw new Error(message);
      }

      if (workflowDraft.action === "convert") {
        await fetch("/api/crm/recommendation-runtime", {
          body: JSON.stringify({
            contactId: workflowDraft.contactId,
            dealId: workflowDraft.dealId || null,
            milestone: "offer_created",
            operation: "offer_milestone",
            reservationId: (data.reservation?.id ?? workflowDraft.reservationId) || null,
            status: "open",
            unitId: workflowDraft.unitId,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => undefined);
      }

      await onReservationChanged?.();
      setWorkflowDraft(null);
      setWorkflowNotice({ kind: "success", message: text.workflowSaved });
    } catch (error) {
      setWorkflowNotice({
        kind: "error",
        message: error instanceof Error ? error.message : text.workflowFailed,
      });
    } finally {
      setWorkflowSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-700">{projectLabel}</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-950">{text.title}</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{text.description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50"
              onClick={resetFilters}
              type="button"
            >
              {text.resetFilters}
            </button>
            <button
              className="rounded-md border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-50"
              onClick={() => openInventory("building")}
              type="button"
            >
              {text.createBuildingAction}
            </button>
            <button
              className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={() => openInventory("unit")}
              type="button"
            >
              {text.createUnitAction}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          {metrics.map((metric) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-4" key={metric.label}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{metric.label}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{metric.value}</p>
            </div>
          ))}
        </div>
      </div>

      {inventoryNotice ? (
        <Pill
          className={
            inventoryNotice.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-rose-200 bg-rose-50 text-rose-900"
          }
        >
          {inventoryNotice.message}
        </Pill>
      ) : null}

      {inventoryMode ? (
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <h4 className="text-lg font-semibold text-slate-950">
            {inventoryMode === "building" ? text.createBuildingTitle : text.createUnitTitle}
          </h4>
          <form className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4" onSubmit={submitInventory}>
            <label className="grid gap-1 text-sm font-semibold text-slate-800">
              {text.projectFilter}
              <select
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                onChange={(event) => updateInventoryDraft("projectId", event.target.value)}
                required
                value={inventoryDraft.projectId}
              >
                <option value="">{text.noProject}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {inventoryMode === "building" ? (
              <>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.buildingName}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("name", event.target.value)}
                    required
                    value={inventoryDraft.name}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800 xl:col-span-2">
                  {text.address}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("address", event.target.value)}
                    value={inventoryDraft.address}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.floors}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    min="0"
                    onChange={(event) => updateInventoryDraft("floors", event.target.value)}
                    type="number"
                    value={inventoryDraft.floors}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.buildingFilter}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("buildingId", event.target.value)}
                    value={inventoryDraft.buildingId}
                  >
                    <option value="">{text.noBuilding}</option>
                    {buildings
                      .filter((building) => building.projectId === inventoryDraft.projectId)
                      .map((building) => (
                        <option key={building.id} value={building.id}>
                          {building.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.unitNumber}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("unitNumber", event.target.value)}
                    required
                    value={inventoryDraft.unitNumber}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.floor}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("floor", event.target.value)}
                    type="number"
                    value={inventoryDraft.floor}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.rooms}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("rooms", event.target.value)}
                    step="0.5"
                    type="number"
                    value={inventoryDraft.rooms}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.area}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("areaSqm", event.target.value)}
                    step="0.1"
                    type="number"
                    value={inventoryDraft.areaSqm}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-800">
                  {text.price}
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                    onChange={(event) => updateInventoryDraft("price", event.target.value)}
                    type="number"
                    value={inventoryDraft.price}
                  />
                </label>
              </>
            )}
            <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50"
                onClick={() => setInventoryMode(null)}
                type="button"
              >
                {text.cancelInventory}
              </button>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                disabled={inventorySaving}
                type="submit"
              >
                {inventorySaving ? text.saving : text.saveInventory}
              </button>
            </div>
          </form>
        </article>
      ) : null}

      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h4 className="text-lg font-semibold text-slate-950">{text.cockpitTitle}</h4>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">{text.cockpitDescription}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill className={blockedViews.length ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}>
              {text.blockedUnitCount(blockedViews.length)}
            </Pill>
            <button
              className="rounded-md border border-stone-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!blockedViews.length}
              onClick={() => setStatusFilter("blocked")}
              type="button"
            >
              {text.showBlockedOnly}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {managementMetrics.map((metric) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={metric.label}>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-stone-500">{metric.label}</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{metric.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h5 className="text-sm font-semibold uppercase tracking-[0.12em] text-stone-500">{text.blockedUnitsTitle}</h5>
            <div className="mt-3 grid gap-2">
              {blockedViews.length ? (
                blockedViews.slice(0, 5).map(({ building, project, unit }) => (
                  <div className="rounded-md bg-white p-3 text-sm" key={unit.id}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold text-slate-950">{unit.unitNumber}</p>
                      <span className="rounded-md border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800">
                        {text.unitStatusLabels.blocked}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-600">
                      {project?.name ?? text.noProject} / {building?.name ?? text.noBuilding} / {formatCurrency(unit.priceCents / 100, language)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-md border border-dashed border-stone-300 bg-white p-3 text-sm text-stone-600">
                  {text.noBlockedUnits}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h5 className="text-sm font-semibold uppercase tracking-[0.12em] text-stone-500">{text.contractMilestonesTitle}</h5>
            <div className="mt-3 grid gap-2">
              {milestoneOptions.map(([milestone, label]) => {
                const count = unitViews.filter(({ reservation }) => reservation?.contractMilestone === milestone).length;

                return (
                  <div className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm" key={milestone}>
                    <span className="break-words font-semibold text-slate-900">{label}</span>
                    <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-semibold text-slate-700">
                      {formatNumber(count, language)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </article>

      {expiringReservations.length ? (
        <article className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h4 className="text-base font-semibold text-amber-950">{text.expiringTitle}</h4>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {expiringReservations.map(({ days, reservation, unit }) => (
              <div className="rounded-md border border-amber-200 bg-white p-3" key={reservation.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-slate-950">
                    {unit?.unitNumber} - {formatDate(reservation.expiresAt, language)}
                  </p>
                  <Pill className="border-amber-200 bg-amber-50 text-amber-900">
                    {days === null || days < 0
                      ? text.reservationOverdue
                      : days === 0
                        ? text.reservationToday
                        : text.reservationDays(days)}
                  </Pill>
                </div>
                <p className="mt-2 text-sm text-stone-700">{reservation.nextAction}</p>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.projectFilter}
            <select
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
              onChange={(event) => {
                setProjectFilter(event.target.value);
                setBuildingFilter("all");
              }}
              value={projectFilter}
            >
              <option value="all">{text.allProjects}</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.statusFilter}
            <select
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
              onChange={(event) => setStatusFilter(event.target.value as UnitStatusFilter)}
              value={statusFilter}
            >
              <option value="all">{text.allStatuses}</option>
              {(["available", "reserved", "blocked", "sold"] as PropertyUnit["status"][]).map((status) => (
                <option key={status} value={status}>
                  {text.unitStatusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.buildingFilter}
            <select
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
              onChange={(event) => setBuildingFilter(event.target.value)}
              value={buildingFilter}
            >
              <option value="all">{text.allBuildings}</option>
              {filteredBuildings.map((building) => (
                <option key={building.id} value={building.id}>
                  {building.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.roomsFilter}
            <select
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
              onChange={(event) => setRoomFilter(event.target.value)}
              value={roomFilter}
            >
              <option value="all">{text.allRooms}</option>
              {roomOptions.map((rooms) => (
                <option key={rooms} value={String(rooms)}>
                  {text.roomsValue(formatNumber(rooms, language))}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.minPrice}
            <input
              className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
              min="0"
              onChange={(event) => setMinPrice(event.target.value)}
              placeholder="0"
              type="number"
              value={minPrice}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            {text.maxPrice}
            <input
              className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
              min="0"
              onChange={(event) => setMaxPrice(event.target.value)}
              placeholder="750000"
              type="number"
              value={maxPrice}
            />
          </label>
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h4 className="text-lg font-semibold text-slate-950">{text.workflowTitle}</h4>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">{text.workflowDescription}</p>
          </div>
          {workflowNotice ? (
            <Pill
              className={
                workflowNotice.kind === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-rose-200 bg-rose-50 text-rose-900"
              }
            >
              {workflowNotice.message}
            </Pill>
          ) : null}
          {runtimeNotice ? (
            <Pill
              className={
                runtimeNotice.kind === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-rose-200 bg-rose-50 text-rose-900"
              }
            >
              {runtimeNotice.message}
            </Pill>
          ) : null}
        </div>

        {workflowDraft && selectedView ? (
          <form className="mt-5 space-y-4" onSubmit={submitReservationWorkflow}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-800">
                {text.selectedUnit}: {selectedView.unit.unitNumber}
              </span>
              {workflowActions.map((action) => {
                const disabled =
                  action === "create"
                    ? selectedView.unit.status !== "available" || selectedHasActiveReservation
                    : !selectedHasActiveReservation;

                return (
                  <button
                    className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                      workflowDraft.action === action
                        ? "border-emerald-700 bg-emerald-700 text-white"
                        : "border-stone-300 text-slate-800 hover:bg-stone-50"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                    disabled={disabled}
                    key={action}
                    onClick={() => updateWorkflowDraft("action", action)}
                    type="button"
                  >
                    {workflowActionLabel(action)}
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {text.contactLabel}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => updateWorkflowDraft("contactId", event.target.value)}
                  required
                  value={workflowDraft.contactId}
                >
                  <option value="">{text.chooseContact}</option>
                  {selectedContacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {text.dealLabel}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => updateWorkflowDraft("dealId", event.target.value)}
                  value={workflowDraft.dealId}
                >
                  <option value="">{text.noDealOption}</option>
                  {selectedDeals.map((deal) => (
                    <option key={deal.id} value={deal.id}>
                      {deal.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {text.expiresAtInput}
                <input
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => updateWorkflowDraft("expiresAt", event.target.value)}
                  required
                  type="datetime-local"
                  value={workflowDraft.expiresAt}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {text.depositLabel}
                <input
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                  min="0"
                  onChange={(event) => updateWorkflowDraft("deposit", event.target.value)}
                  placeholder="0"
                  step="100"
                  type="number"
                  value={workflowDraft.deposit}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {text.milestoneLabel}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => updateWorkflowDraft("contractMilestone", event.target.value)}
                  value={workflowDraft.contractMilestone}
                >
                  {milestoneOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800 md:col-span-2 xl:col-span-3">
                {text.nextActionInput}
                <input
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => updateWorkflowDraft("nextAction", event.target.value)}
                  value={workflowDraft.nextAction}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  checked={workflowDraft.createTask}
                  className="size-4 rounded border-stone-300"
                  onChange={(event) => updateWorkflowDraft("createTask", event.target.checked)}
                  type="checkbox"
                />
                {text.createTask}
              </label>
              <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  checked={workflowDraft.notifyTeams}
                  className="size-4 rounded border-stone-300"
                  onChange={(event) => updateWorkflowDraft("notifyTeams", event.target.checked)}
                  type="checkbox"
                />
                {text.notifyTeams}
              </label>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSaveWorkflow || workflowSaving}
                type="submit"
              >
                {workflowSaving ? text.saving : text.saveAction}
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-4 text-sm text-stone-600">{text.workflowSelectHint}</p>
        )}
      </article>

      <article className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-5 py-4">
          <h4 className="text-lg font-semibold text-slate-950">{text.tableTitle}</h4>
          <p className="mt-1 text-sm text-stone-600">{text.tableDescription}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1360px] w-full border-collapse text-left text-sm">
            <thead className="bg-stone-50 text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">
              <tr>
                <th className="px-4 py-3">{text.unit}</th>
                <th className="px-4 py-3">{text.status}</th>
                <th className="px-4 py-3">{text.price}</th>
                <th className="px-4 py-3">{text.area}</th>
                <th className="px-4 py-3">{text.rooms}</th>
                <th className="px-4 py-3">{text.floor}</th>
                <th className="px-4 py-3">{text.buyer}</th>
                <th className="px-4 py-3">{text.deal}</th>
                <th className="px-4 py-3">{text.reservation}</th>
                <th className="px-4 py-3">{text.buyerMatches}</th>
                <th className="px-4 py-3">{text.actions}</th>
              </tr>
            </thead>
            <tbody>
              {unitViews.map((view) => {
                const { building, buyer, buyerMatches, deal, project, reservation, unit } = view;
                const hasActiveReservation = isActiveReservation(reservation);

                return (
                  <tr className="border-t border-stone-100 align-top" key={unit.id}>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-slate-950">{unit.unitNumber}</p>
                      <p className="mt-1 text-xs text-stone-500">{building?.name ?? text.noBuilding}</p>
                      <p className="mt-1 text-xs text-stone-500">{project?.name ?? text.noProject}</p>
                    </td>
                    <td className="px-4 py-4">
                      <Pill className={statusStyles[unit.status]}>{text.unitStatusLabels[unit.status]}</Pill>
                    </td>
                    <td className="px-4 py-4 font-semibold text-slate-950">
                      {formatCurrency(unit.priceCents / 100, language)}
                    </td>
                    <td className="px-4 py-4 text-slate-700">{text.areaValue(formatNumber(unit.areaSqm, language))}</td>
                    <td className="px-4 py-4 text-slate-700">{formatNumber(unit.rooms, language)}</td>
                    <td className="px-4 py-4 text-slate-700">{formatNumber(unit.floor, language)}</td>
                    <td className="px-4 py-4">
                      {buyer ? (
                        <>
                          <p className="font-semibold text-slate-950">{buyer.name}</p>
                          <p className="mt-1 text-xs text-stone-500">{buyer.email ?? buyer.phone ?? text.noContactData}</p>
                        </>
                      ) : (
                        <span className="text-stone-500">{text.noBuyer}</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {deal ? (
                        <>
                          <p className="font-semibold text-slate-950">{deal.name}</p>
                          <p className="mt-1 text-xs text-stone-500">{deal.stage}</p>
                        </>
                      ) : (
                        <span className="text-stone-500">{text.noDeal}</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {reservation ? (
                        <div className="max-w-xs">
                          <Pill className={reservationStyles[reservation.status]}>
                            {text.reservationStatusLabels[reservation.status]}
                          </Pill>
                          <p className="mt-2 text-xs font-semibold text-slate-800">
                            {text.expiresAt}: {formatDate(reservation.expiresAt, language)}
                          </p>
                          <p className="mt-1 text-xs text-stone-600">
                            {text.contractMilestoneLabels[reservation.contractMilestone]}
                          </p>
                          <p className="mt-1 text-xs text-stone-600">{reservation.nextAction}</p>
                        </div>
                      ) : (
                        <span className="text-stone-500">{text.noReservation}</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {buyerMatches.length ? (
                        <div className="grid max-w-xs gap-2">
                          {buyerMatches.map((match) => (
                            <div className="rounded-md border border-emerald-100 bg-emerald-50 p-2" key={match.lead.id}>
                              <div className="flex items-start justify-between gap-2">
                                <p className="break-words text-xs font-semibold text-emerald-950">
                                  {match.contact?.name ?? match.lead.id}
                                </p>
                                <span className="shrink-0 rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                                  {text.matchScore(match.score)}
                                </span>
                              </div>
                              <p className="mt-1 break-words text-[11px] text-emerald-900">
                                {match.reasons.length ? match.reasons.join(" / ") : match.lead.intent}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-stone-500">{text.noBuyerMatches}</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex min-w-36 flex-col gap-2">
                        <button
                          className="rounded-md border border-stone-300 px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={unit.status !== "available" || hasActiveReservation}
                          onClick={() => openWorkflow(view, "create")}
                          type="button"
                        >
                          {text.reserveAction}
                        </button>
                        <button
                          className="rounded-md border border-stone-300 px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!hasActiveReservation}
                          onClick={() => openWorkflow(view, "extend")}
                          type="button"
                        >
                          {text.extendAction}
                        </button>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            className="rounded-md border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!hasActiveReservation}
                            onClick={() => openWorkflow(view, "expire")}
                            type="button"
                          >
                            {text.expireAction}
                          </button>
                          <button
                            className="rounded-md border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!hasActiveReservation}
                            onClick={() => openWorkflow(view, "convert")}
                            type="button"
                          >
                            {text.convertAction}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            className="rounded-md border border-stone-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={Boolean(runtimeBusyKey) || (!buyer && !buyerMatches.length)}
                            onClick={() => void createViewingSlot(view)}
                            type="button"
                          >
                            {runtimeBusyKey === `viewing:${unit.id}` ? text.saving : text.viewingSlotAction}
                          </button>
                          <button
                            className="rounded-md border border-stone-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={Boolean(runtimeBusyKey) || !reservation}
                            onClick={() => void createOfferMilestone(view)}
                            type="button"
                          >
                            {runtimeBusyKey === `offer:${unit.id}` ? text.saving : text.offerMilestoneAction}
                          </button>
                        </div>
                        <button
                          className="rounded-md border border-rose-200 px-3 py-2 text-left text-xs font-semibold text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={Boolean(runtimeBusyKey) || (!reservation && !deal)}
                          onClick={() => void markOfferLost(view)}
                          type="button"
                        >
                          {runtimeBusyKey === `offer-lost:${unit.id}` ? text.saving : text.offerLostAction}
                        </button>
                        <button
                          className="rounded-md border border-stone-300 px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={Boolean(runtimeBusyKey)}
                          onClick={() => void createUnitAudit(view)}
                          type="button"
                        >
                          {runtimeBusyKey === `audit:${unit.id}` ? text.saving : text.unitAuditAction}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {unitViews.length === 0 ? (
          <div className="border-t border-stone-100 p-5">
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5">
              <p className="text-base font-semibold text-slate-950">{text.emptyTitle}</p>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{text.empty}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                  onClick={resetFilters}
                  type="button"
                >
                  {text.emptyResetFilters}
                </button>
                <button
                  className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                  onClick={() => openInventory("unit")}
                  type="button"
                >
                  {text.emptyImportOrCreate}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </article>
    </section>
  );
}
