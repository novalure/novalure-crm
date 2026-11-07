"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isPropertySalesHistoryPage, type PropertySalesHistoryItem, type PropertySalesHistoryKind } from "@/lib/property-sales-history";

export type HistoryUnit = { id: string; label: string };
export type HistoryReservation = { id: string; unitId: string; status: string; createdAt: string | null };
export type CurrentWithdrawal = { reservationId: string; unitId: string; withdrawnAt: string | null };

type HistoryProps = {
  workspaceId: string;
  projectId: string;
  units: HistoryUnit[];
  reservations: HistoryReservation[];
  currentWithdrawals: CurrentWithdrawal[];
  refreshVersion: number;
};
type TimelineProps = Pick<HistoryProps, "workspaceId" | "projectId" | "currentWithdrawals"> & { unitId: string; reservationId: string | null };
type HistoryState = { items: PropertySalesHistoryItem[]; nextCursor: string | null; loaded: boolean; error: string; denied: boolean };

const selectClass = "min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white p-2 text-sm";
const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50";
const names: Record<PropertySalesHistoryKind, string> = {
  "reservation.request": "Reservierung angefragt",
  "reservation.confirm": "Reservierung bestätigt",
  "reservation.extend": "Reservierung verlängert",
  "reservation.expire": "Reservierungsfrist abgelaufen",
  "reservation.withdraw": "Reservierung zurückgenommen",
  "unit.audit": "Bestandsänderung dokumentiert",
};
const statuses: Record<string, string> = {
  requested: "Angefragt", hold: "Vorgemerkt", reserved: "Reserviert", expired: "Abgelaufen",
  converted: "In einen Verkauf überführt", withdrawn: "Zurückgenommen", available: "Verfügbar", sold: "Verkauft", blocked: "Gesperrt",
};

function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Nicht dokumentiert";
  return new Date(value).toLocaleString("de-AT", { dateStyle: "medium", timeStyle: "short" });
}

function HistoryEvent({ item }: { item: PropertySalesHistoryItem }) {
  return <li className="min-w-0 rounded-md border border-stone-200 bg-white p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h5 className="font-semibold">{names[item.kind]}</h5>
      <time className="text-sm text-stone-600" dateTime={item.occurredAt}>{dateLabel(item.occurredAt)}</time>
    </div>
    <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-stone-600">Bearbeiter</dt><dd>{item.actor.name ?? (item.actor.id ? "Name nicht dokumentiert" : "Nicht dokumentiert")}</dd></div>
      <div><dt className="text-stone-600">Dokumentierter Status</dt><dd>{item.status.before === null ? "Vorheriger Status unbekannt" : statuses[item.status.before]} → {item.status.after === null ? "Neuer Status nicht dokumentiert" : statuses[item.status.after]}</dd></div>
      {item.source === "reservation_command" && <>
        <div><dt className="text-stone-600">Bisherige Reservierungsfrist</dt><dd>{item.expiresAt.before === null ? "Unbekannt" : dateLabel(item.expiresAt.before)}</dd></div>
        <div><dt className="text-stone-600">Dokumentierte Reservierungsfrist</dt><dd>{dateLabel(item.expiresAt.after)}</dd></div>
        <div><dt className="text-stone-600">Reservierungsstand</dt><dd>{item.reservationVersion === null ? "Version nicht dokumentiert" : `Version ${item.reservationVersion}`}</dd></div>
      </>}
      <div><dt className="text-stone-600">Einheitenstand</dt><dd>{item.unitVersion === null ? "Version nicht dokumentiert" : `Version ${item.unitVersion}`}</dd></div>
      <div className="min-w-0 sm:col-span-2"><dt className="text-stone-600">Quellbeleg</dt><dd className="whitespace-pre-wrap break-words">{item.sourceReference || "Nicht dokumentiert"}</dd></div>
      {item.taskId && <div className="sm:col-span-2"><dt className="text-stone-600">Nachverfolgung</dt><dd>Eine zugehörige Aufgabe ist dokumentiert.</dd></div>}
    </dl>
    {item.kind === "reservation.withdraw" && <p className="mt-2 text-sm text-stone-600">Vertragliche Folgen und eine mögliche Anzahlung müssen manuell geprüft werden.</p>}
    <details className="mt-2 min-w-0 text-xs text-stone-600">
      <summary className="min-h-6 cursor-pointer">Referenzen für Rückfragen</summary>
      <dl className="mt-1 grid gap-1 break-all">
        <div><dt className="inline">Ereignis: </dt><dd className="inline">{item.id}</dd></div>
        {item.actor.id && <div><dt className="inline">Bearbeiter: </dt><dd className="inline">{item.actor.id}</dd></div>}
        {item.reservationId && <div><dt className="inline">Reservierung: </dt><dd className="inline">{item.reservationId}</dd></div>}
        {item.taskId && <div><dt className="inline">Aufgabe: </dt><dd className="inline">{item.taskId}</dd></div>}
      </dl>
    </details>
  </li>;
}

function HistoryTimeline({ workspaceId, projectId, unitId, reservationId, currentWithdrawals }: TimelineProps) {
  const [state, setState] = useState<HistoryState>({ items: [], nextCursor: null, loaded: false, error: "", denied: false });
  const [loading, setLoading] = useState(true);
  const request = useRef({ mounted: false, sequence: 0, busy: false, controller: null as AbortController | null, cursors: new Set<string>() });

  useLayoutEffect(() => {
    const lifecycle = request.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.sequence += 1;
      lifecycle.controller?.abort();
      lifecycle.controller = null;
      lifecycle.busy = false;
    };
  }, []);

  const load = useCallback(async (cursor: string | null) => {
    const lifecycle = request.current;
    if (!lifecycle.mounted || lifecycle.busy) return;
    lifecycle.busy = true;
    const sequence = ++lifecycle.sequence;
    const controller = new AbortController();
    lifecycle.controller = controller;
    const current = () => lifecycle.mounted && sequence === lifecycle.sequence;
    setLoading(true);
    setState(previous => ({ ...previous, error: "" }));
    try {
      const params = new URLSearchParams({ workspaceId, projectId, unitId });
      if (reservationId) params.set("reservationId", reservationId);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/crm/property-sales/history?${params}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) {
        const denied = response.status === 401 || response.status === 403 || response.status === 404;
        setState(previous => ({ ...previous, ...(denied ? { items: [], nextCursor: null, loaded: false } : {}), denied,
          error: denied ? "Der Verlauf ist für diese Auswahl nicht verfügbar. Bitte prüfen Sie Ihre Projektberechtigung oder melden Sie sich erneut an."
            : response.status === 400 ? "Diese Verlaufsseite kann nicht geladen werden. Bitte aktualisieren Sie den Verlauf."
              : "Der Verlauf konnte nicht geladen werden. Bitte versuchen Sie es erneut." }));
        return;
      }
      const result: unknown = await response.json();
      if (!current()) return;
      const page = result && typeof result === "object" && "source" in result && result.source === "database" && "data" in result ? result.data : null;
      if (!isPropertySalesHistoryPage(page) || page.workspaceId !== workspaceId || page.projectId !== projectId || page.unitId !== unitId || page.reservationId !== reservationId
        || (page.nextCursor !== null && (page.nextCursor === cursor || (cursor !== null && lifecycle.cursors.has(page.nextCursor))))) {
        setState(previous => ({ ...previous, error: "Die Antwort konnte dieser Auswahl nicht sicher zugeordnet werden. Bitte aktualisieren Sie den Verlauf." }));
        return;
      }
      if (cursor === null) lifecycle.cursors.clear();
      else lifecycle.cursors.add(cursor);
      setState(previous => {
        const items = cursor === null ? [] : previous.items;
        const known = new Set(items.map(item => `${item.source}:${item.id}`));
        return { items: [...items, ...page.items.filter(item => {
          const key = `${item.source}:${item.id}`;
          if (known.has(key)) return false;
          known.add(key);
          return true;
        })], nextCursor: page.nextCursor, loaded: true, error: "", denied: false };
      });
    } catch {
      if (current()) setState(previous => ({ ...previous, error: "Die Verbindung zum Verlauf ist unterbrochen. Bitte versuchen Sie es erneut." }));
    } finally {
      if (current()) {
        lifecycle.busy = false;
        lifecycle.controller = null;
        setLoading(false);
      }
    }
  }, [workspaceId, projectId, unitId, reservationId]);

  useEffect(() => { void load(null); }, [load]);

  const reservationEvents = state.items.filter(item => item.source === "reservation_command");
  const unitEvents = state.items.filter(item => item.source === "unit_audit");
  const recordedWithdrawals = new Set(reservationEvents.filter(item => item.kind === "reservation.withdraw").map(item => item.reservationId));
  const legacyWithdrawals = state.loaded && !state.denied ? currentWithdrawals.filter(item => item.unitId === unitId && (!reservationId || item.reservationId === reservationId) && !recordedWithdrawals.has(item.reservationId)) : [];
  return <div className="mt-4 min-w-0 space-y-4" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-stone-600">{loading ? "Verlauf wird geladen…" : state.loaded ? `${state.items.length} aufgezeichnete Ereignisse geladen` : "Noch kein Verlauf geladen"}</p>
      <button type="button" className={buttonClass} disabled={loading} onClick={() => void load(null)}>Verlauf aktualisieren</button>
    </div>
    {state.error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
    {state.loaded && <>
      {state.items.length === 0 && <p className="rounded-md bg-stone-50 p-3 text-sm">Für diese Auswahl sind keine aufgezeichneten Ereignisse vorhanden.</p>}
      {reservationEvents.length > 0 && <section aria-label="Reservierungsereignisse"><h4 className="mb-2 font-semibold">Reservierungsverlauf</h4><ol className="grid gap-3">{reservationEvents.map(item => <HistoryEvent key={`${item.source}:${item.id}`} item={item} />)}</ol></section>}
      {unitEvents.length > 0 && <section aria-label="Bestandsereignisse"><h4 className="mb-2 font-semibold">Bestandsereignisse der Einheit</h4><ol className="grid gap-3">{unitEvents.map(item => <HistoryEvent key={`${item.source}:${item.id}`} item={item} />)}</ol></section>}
      {state.nextCursor && <button type="button" className={buttonClass} disabled={loading} onClick={() => void load(state.nextCursor)}>Weitere Ereignisse laden (bis zu 40)</button>}
    </>}
    {legacyWithdrawals.length > 0 && <section className="rounded-md border border-stone-200 p-3" aria-label="Gespeicherte Rücknahmebelege">
      <h4 className="font-semibold">Gespeicherte Rücknahmebelege</h4>
      <p className="mt-1 text-sm text-stone-600">Diese Rücknahmen sind im aktuellen Reservierungsbestand dokumentiert. Ein vollständiges Änderungsereignis ist im geladenen Verlauf nicht enthalten. Sie werden nicht als zusätzliche Ereignisse gezählt.</p>
      <ul className="mt-2 grid gap-2 text-sm">{legacyWithdrawals.map(item => <li key={item.reservationId} className="min-w-0 rounded-md bg-stone-50 p-2">
        <p>Reservierung zurückgenommen · {dateLabel(item.withdrawnAt)}</p>
        <p className="mt-1 text-stone-600">Vertragliche Folgen und eine mögliche Anzahlung müssen manuell geprüft werden.</p>
        <details className="mt-1 text-xs"><summary className="cursor-pointer">Reservierungsreferenz</summary><p className="break-all">{item.reservationId}</p></details>
      </li>)}</ul>
    </section>}
  </div>;
}

export function ReservationHistory({ workspaceId, projectId, units, reservations, currentWithdrawals, refreshVersion }: HistoryProps) {
  const [selection, setSelection] = useState({ unitId: "", reservationId: "" });
  const unitId = units.some(unit => unit.id === selection.unitId) ? selection.unitId : "";
  const availableReservations = reservations.filter(item => item.unitId === unitId);
  const reservationAvailable = !selection.reservationId || availableReservations.some(item => item.id === selection.reservationId);
  const reservationId = selection.reservationId || null;
  const scope = JSON.stringify([workspaceId, projectId, unitId, reservationId, refreshVersion]);
  return <section className="mt-5 min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4" aria-label="Einheiten- und Reservierungshistorie">
    <h3 className="text-lg font-semibold">Einheiten- und Reservierungshistorie</h3>
    <p className="my-2 text-sm text-stone-600">Wählen Sie eine Einheit, um dokumentierte Änderungen nachzuvollziehen. Der Verlauf enthält aufgezeichnete Ereignisse. Frühere Werte können unbekannt sein. Zeitangaben werden in Ihrer lokalen Zeitzone angezeigt.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-sm">Einheit für den Verlauf<select aria-label="Einheit für den Verlauf" className={selectClass} value={unitId} onChange={event => setSelection({ unitId: event.target.value, reservationId: "" })}>
        <option value="">Bitte Einheit wählen</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
      </select></label>
      <label className="grid min-w-0 gap-1 text-sm">Reservierung eingrenzen (optional)<select aria-label="Reservierung eingrenzen (optional)" className={selectClass} value={reservationId ?? ""} disabled={!unitId} onChange={event => setSelection(current => ({ ...current, reservationId: event.target.value }))}>
        <option value="">Alle Reservierungen und Bestandsereignisse</option>{!reservationAvailable && <option value={selection.reservationId}>Gewählte Reservierung nicht mehr verfügbar</option>}{availableReservations.map((item, index) => <option key={item.id} value={item.id}>Reservierung {index + 1} · {statuses[item.status] ?? "Status nicht dokumentiert"}{item.createdAt ? ` · ${dateLabel(item.createdAt)}` : ""}</option>)}
      </select></label>
    </div>
    {unitId && !reservationAvailable ? <p className="mt-3 text-sm text-stone-600" role="status">Die gewählte Reservierung ist nicht mehr verfügbar. Bitte wählen Sie die Reservierung erneut oder öffnen Sie den gesamten Einheitenverlauf.</p>
      : unitId ? <HistoryTimeline key={scope} workspaceId={workspaceId} projectId={projectId} unitId={unitId} reservationId={reservationId} currentWithdrawals={currentWithdrawals} />
      : <p className="mt-3 text-sm text-stone-600">{units.length ? "Bitte wählen Sie eine Einheit für den Verlauf." : "Für dieses Projekt sind keine Einheiten verfügbar."}</p>}
  </section>;
}
