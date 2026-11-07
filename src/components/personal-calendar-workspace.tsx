"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { Project } from "@/lib/crm-types";
import type { LanguageCode } from "@/lib/language-runtime";
import type { PersonalCalendarDraft, PersonalCalendarEvent, PersonalCalendarRemoteSnapshot } from "@/lib/personal-calendar";
import { csrfFetch } from "@/lib/security/csrf-client";
import { localParts } from "@/lib/booking/rules";
import { usePersonalCalendarSessionStore, type PersonalCalendarAttempt, type PersonalCalendarClientEntry, type PersonalCalendarClientStore, type PersonalCalendarForm } from "@/lib/personal-calendar-client-store";

type Provider = "microsoft" | "google";
type Calendar = { id: string; name: string; canRead: boolean; canWrite: boolean; protectedReadOnly: boolean };
type Connection = { id: string; userId: string; provider: Provider; connected: boolean; status: string; accountLabel: string | null; revision: number; calendars: Calendar[]; writeCalendarId: string | null; conflictCalendarIds: string[] };
type Data = { workspaceId: string; actorId: string; events: PersonalCalendarEvent[]; connections: Connection[]; recurrence: { creationSupported: false; busyInstancesRead: true } };
type Props = { workspaceId: string; sessionUserId: string; language: LanguageCode | "es"; activeProjectId: string | null; projects: Pick<Project, "id" | "name">[]; store?: PersonalCalendarClientStore; onEventsChanged?: () => Promise<void> | void };
const panel = "rounded-lg border border-stone-200 bg-white p-5";
const field = "min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950";
const button = "min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50";
const providers: Provider[] = ["microsoft", "google"];

/** Enumerate real instants, preserving DST gaps and both autumn occurrences. */
export function personalCalendarWallInstants(value: string, timeZone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return [];
  const middle = Date.parse(`${value}Z`);
  if (!Number.isFinite(middle) || new Date(middle).toISOString().slice(0, 16) !== value) return [];
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(middle);
    const wantedDate = value.slice(0, 10), wantedMinute = Number(value.slice(11, 13)) * 60 + Number(value.slice(14));
    const result: string[] = [];
    for (let instant = middle - 15 * 3_600_000; instant <= middle + 15 * 3_600_000; instant += 60_000) {
      const parts = localParts(instant, timeZone);
      if (parts.date === wantedDate && parts.minute === wantedMinute) result.push(new Date(instant).toISOString());
    }
    return result;
  } catch { return []; }
}
function wallInput(instant: string, zone: string) {
  const parts = localParts(Date.parse(instant), zone);
  return `${parts.date}T${String(Math.floor(parts.minute / 60)).padStart(2, "0")}:${String(parts.minute % 60).padStart(2, "0")}`;
}
function selectedInstant(candidates: string[], preserved: string) {
  // A text-only edit must not truncate provider seconds/milliseconds. The
  // stored instant is cleared by changes to the wall field or its time zone.
  const matching = candidates.some(candidate => Math.floor(Date.parse(candidate) / 60_000) === Math.floor(Date.parse(preserved) / 60_000));
  return matching ? preserved : candidates.length === 1 ? candidates[0] : undefined;
}
function initialForm(projectId: string | null): PersonalCalendarForm {
  return { provider: "microsoft", title: "", startsAt: "", endsAt: "", startInstant: "", endInstant: "", timeZone: "Europe/Vienna", location: "", projectId: projectId ?? "", attendees: "", attendeeNames: {}, invitationsConfirmed: false };
}
function validDraft(value: unknown): value is PersonalCalendarDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as PersonalCalendarDraft;
  if (typeof draft.title !== "string" || typeof draft.location !== "string" || typeof draft.timeZone !== "string" ||
    typeof draft.startsAt !== "string" || typeof draft.endsAt !== "string" || !Number.isFinite(Date.parse(draft.startsAt)) ||
    !Number.isFinite(Date.parse(draft.endsAt)) || Date.parse(draft.endsAt) <= Date.parse(draft.startsAt) ||
    !(draft.projectId === null || typeof draft.projectId === "string") || !Array.isArray(draft.attendees) || draft.attendees.length > 10 ||
    draft.attendees.some(attendee => !attendee || typeof attendee.email !== "string" || typeof attendee.name !== "string")) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: draft.timeZone }).format(); return true; } catch { return false; }
}
function validPersonalEvent(value: unknown): value is PersonalCalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as PersonalCalendarEvent;
  if (event.origin !== "personal_standalone" || !/^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(event.id) ||
    !Number.isSafeInteger(event.version) || event.version < 1 || !validDraft(event.event) || !providers.includes(event.provider) ||
    typeof event.canEdit !== "boolean" || typeof event.canCancel !== "boolean" || typeof event.canImport !== "boolean" ||
    !["processing", "uncertain", "synced", "conflict", "cancelled", "failed"].includes(event.state)) return false;
  const remote = event.remoteSnapshot;
  return remote === null || Boolean(remote && typeof remote.eventId === "string" && remote.eventId &&
    typeof remote.verifiedAt === "string" && Number.isFinite(Date.parse(remote.verifiedAt)) && typeof remote.cancelled === "boolean" &&
    (remote.etag === null || typeof remote.etag === "string") && validDraft({ ...remote, projectId: null }));
}
function parseData(value: unknown, workspaceId: string): Data {
  if (!value || typeof value !== "object") throw new Error("calendar_response_invalid");
  const data = value as Data;
  if (data.workspaceId !== workspaceId || !/^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(data.actorId) || !Array.isArray(data.events) || !Array.isArray(data.connections) || !data.recurrence || data.recurrence.creationSupported !== false || data.recurrence.busyInstancesRead !== true) throw new Error("calendar_response_invalid");
  if (data.events.some(event => !validPersonalEvent(event)) || data.connections.some(connection => connection.userId !== data.actorId || !providers.includes(connection.provider) || !Array.isArray(connection.calendars))) throw new Error("calendar_response_invalid");
  return data;
}
function confirmed(event: PersonalCalendarEvent) {
  return event.state === "synced" && Boolean(event.providerEventId && event.remoteSnapshot?.verifiedAt && event.remoteSnapshot.eventId === event.providerEventId && !event.remoteSnapshot.cancelled);
}

export function PersonalCalendarWorkspace({ workspaceId, sessionUserId, language, activeProjectId, projects, store: suppliedStore, onEventsChanged }: Props) {
  const de = language === "de", es = language === "es";
  const t = useCallback((german: string, english: string, spanish = english) => de ? german : es ? spanish : english, [de, es]);
  const headingId = useId(), helpId = useId();
  const ownStore = usePersonalCalendarSessionStore(sessionUserId);
  const store = suppliedStore?.ownerUserId === sessionUserId ? suppliedStore : ownStore;
  const resourceKey = JSON.stringify([sessionUserId, workspaceId]);
  const endpoint = `/api/crm/personal-calendar?workspaceId=${encodeURIComponent(workspaceId)}`;
  const [loaded, setLoaded] = useState<{ scope: string; data: Data | null; error: string }>({ scope: resourceKey, data: null, error: "" });
  const data = loaded.scope === resourceKey ? loaded.data : null;
  const scope = JSON.stringify([sessionUserId, workspaceId, data?.actorId ?? "unresolved"]);
  const initial = useMemo<PersonalCalendarClientEntry>(() => ({ form: initialForm(activeProjectId), editingId: null, editingVersion: null, pending: null, notice: "", reloadVersion: 0, awaitingReload: false }), [activeProjectId]);
  const entry = useSyncExternalStore(store.subscribe, () => store.read(scope) ?? initial, () => initial);
  const busy = useSyncExternalStore(store.subscribe, store.isBusy, () => false);
  const otherPending = useSyncExternalStore(store.subscribe, () => store.hasPendingOutside(scope), () => false);
  const { form, pending } = entry;
  const locked = busy || entry.awaitingReload;
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<Partial<Record<Provider, { writeCalendarId: string; conflictCalendarIds: string[] }>>>({});
  const [cancellationConfirmed, setCancellationConfirmed] = useState<Record<string, boolean>>({});
  const currentScope = useRef(scope);
  const parentChanged = useRef(onEventsChanged);
  const parentNotified = useRef("");
  useLayoutEffect(() => { parentChanged.current = onEventsChanged; }, [onEventsChanged]);
  useLayoutEffect(() => { currentScope.current = scope; return () => { currentScope.current = ""; }; }, [scope]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: "no-store", signal });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "calendar_unavailable");
    return parseData(result, workspaceId);
  }, [endpoint, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setLoaded({ scope: resourceKey, data: value, error: "" });
      store.reloaded(scope, entry.reloadVersion);
      const completion = `${scope}:${entry.reloadVersion}`;
      if (entry.reloadVersion > 0 && currentScope.current === scope && parentNotified.current !== completion) {
        parentNotified.current = completion;
        void Promise.resolve(parentChanged.current?.()).catch(() => {
          if (currentScope.current === scope) store.update(scope, initial, previous => ({ ...previous, notice: t("Der Termin ist erfasst; die CRM-Übersicht konnte nicht neu geladen werden.", "The event is recorded, but the CRM overview could not reload.", "El evento está registrado, pero no se pudo recargar el resumen del CRM.") }));
        });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ scope: resourceKey, data: null, error: error instanceof Error ? error.message : "calendar_unavailable" });
    });
    return () => controller.abort();
  // Completion is scoped RAM state, so a late response also invalidates a newly
  // mounted instance. No mutation is automatically replayed by this effect.
  }, [load, refresh, resourceKey, scope, entry.reloadVersion, store, initial, t]);
  function update(change: Partial<PersonalCalendarForm>) {
    if (store.read(scope)?.pending || locked) return;
    store.update(scope, initial, previous => ({ ...previous, notice: "", form: { ...previous.form, ...change } }));
  }
  function notice(message: string) { store.update(scope, initial, previous => ({ ...previous, notice: message })); }
  const unknownMessage = t("Ergebnis noch unklar. Prüfe denselben Vorgang erneut. Eingaben und Kennung bleiben erhalten.", "The outcome is unknown. Check the same operation again; inputs and identifier are retained.", "Resultado pendiente. Comprueba la misma operación; se conservan los datos y su identificador.");
  function errorText(code: string) {
    if (/scope|forbidden|permission|denied|activation/i.test(code)) return t("Für diesen persönlichen Kalender ist die Aktion nicht freigegeben.", "This action is not authorized for this personal calendar.", "Esta acción no está autorizada para este calendario personal.");
    if (/binding_in_use|writer_already_assigned/i.test(code)) return t("Die Kalenderauswahl wird bereits von Buchungen verwendet. Sie wurde nicht geändert.", "Bookings already use this calendar binding. The selection was not changed.", "Las reservas ya utilizan este calendario. La selección no ha cambiado.");
    if (/version|etag|conflict|changed/i.test(code)) return t("Der Termin oder die Verbindung wurde geändert. Lade den Stand neu und prüfe den Vergleich.", "The event or connection changed. Reload and review the comparison.", "El evento o la conexión ha cambiado. Recarga y revisa la comparación.");
    if (/reauth|not_connected|credentials|write_unavailable/i.test(code)) return t("Verbinde das persönliche Konto erneut und prüfe den Schreibkalender.", "Reconnect your personal account and check the write calendar.", "Vuelve a conectar tu cuenta personal y revisa el calendario de escritura.");
    return t("Die Aktion konnte nicht bestätigt werden. Prüfe Verbindung und aktuellen Stand.", "The action could not be confirmed. Check the connection and current state.", "No se ha podido confirmar la acción. Revisa la conexión y el estado actual.");
  }
  async function send(body?: Record<string, unknown>) {
    if (store.read(scope)?.awaitingReload && !store.read(scope)?.pending) return;
    const token = store.acquire();
    if (!token) return;
    let attempt = store.read(scope)?.pending ?? null;
    try {
      if (!attempt) {
        if (!body || !data) return;
        const key = crypto.randomUUID();
        attempt = { key, endpoint, body: JSON.stringify({ ...body, expectedActorId: data.actorId, idempotencyKey: key }), action: String(body.action), eventId: typeof body.eventId === "string" ? body.eventId : undefined, submittedForm: form, phase: "running" };
      }
      const activeAttempt: PersonalCalendarAttempt = { ...attempt, phase: "running" };
      store.update(scope, initial, previous => ({ ...previous, pending: activeAttempt, notice: "" }));
      const response = await csrfFetch(attempt.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: attempt.body });
      const result = await response.json().catch(() => null) as { event?: PersonalCalendarEvent; connection?: Connection; error?: string; notStarted?: boolean } | null;
      if (!response.ok) {
        if (response.status < 500 && result?.notStarted === true && attempt.phase !== "uncertain") store.finish(scope, attempt.key, initial, errorText(result.error ?? "calendar_unavailable"), false);
        else store.uncertain(scope, attempt.key, unknownMessage);
        return;
      }
      const bridge = ["refresh_calendars", "select_calendar"].includes(attempt.action);
      if (!result || (!bridge && (!validPersonalEvent(result.event) || (attempt.eventId && result.event.id !== attempt.eventId))) || (bridge && (!result.connection || result.connection.userId !== JSON.parse(attempt.body).expectedActorId || result.connection.provider !== JSON.parse(attempt.body).provider))) {
        store.uncertain(scope, attempt.key, unknownMessage); return;
      }
      const event = result.event;
      if (event && ((event.state === "synced" && !confirmed(event)) || (event.state === "cancelled" && event.providerEventId && !event.remoteSnapshot?.cancelled))) {
        store.uncertain(scope, attempt.key, unknownMessage); return;
      }
      if (event && ["processing", "uncertain"].includes(event.state)) {
        // A durable journal row is a recoverable operation, not a provider confirmation.
        // Retire the form intent so it cannot become an accidental fresh create later.
        store.finish(scope, attempt.key, initial, unknownMessage, ["create", "update"].includes(attempt.action));
      } else {
        const message = event ? confirmed(event) ? t("Termin beim Anbieter nachgewiesen.", "Calendar event verified with the provider.", "Evento verificado con el proveedor.") : event.state === "cancelled" && !event.providerEventId ? t("Lokaler Entwurf verworfen. Kein Anbietertermin wurde gelöscht.", "Local draft discarded. No provider event was deleted.", "Borrador local descartado. No se eliminó ningún evento del proveedor.") : event.state === "cancelled" && event.remoteSnapshot?.cancelled ? t("Absage beim Anbieter nachgewiesen.", "Cancellation verified with the provider.", "Cancelación verificada con el proveedor.") : event.state === "conflict" ? t("Externe Änderung erkannt. Prüfe den Vergleich vor einer Übernahme.", "External change detected. Review the comparison before importing.", "Se ha detectado un cambio externo. Revisa la comparación antes de importarlo.") : errorText(event.errorCode ?? "calendar_unavailable") : t("Kalenderverbindung aktualisiert.", "Calendar connection updated.", "Conexión actualizada.");
        store.finish(scope, attempt.key, initial, message, Boolean(event && confirmed(event) && ["create", "update"].includes(attempt.action)));
      }
      if (currentScope.current === scope && bridge) setSelection({});
    } catch {
      if (attempt && store.read(scope)?.pending?.key === attempt.key) store.uncertain(scope, attempt.key, unknownMessage);
      else if (currentScope.current === scope) notice(t("Der Vorgang ist erfasst; die Ansicht konnte nicht neu geladen werden. Bitte aktualisieren.", "The operation is recorded, but the view could not reload. Refresh it.", "La operación está registrada, pero no se pudo recargar la vista."));
    } finally { store.release(token); }
  }
  const startCandidates = useMemo(() => personalCalendarWallInstants(form.startsAt, form.timeZone), [form.startsAt, form.timeZone]);
  const endCandidates = useMemo(() => personalCalendarWallInstants(form.endsAt, form.timeZone), [form.endsAt, form.timeZone]);
  const selectedConnection = data?.connections.find(connection => connection.provider === form.provider);
  const writer = selectedConnection?.calendars.find(calendar => calendar.id === selectedConnection.writeCalendarId);
  const unresolved = data?.events.some(event => ["processing", "uncertain"].includes(event.state));
  const previousAttendees = entry.editingId ? Object.keys(form.attendeeNames) : [];
  const invitationRecipients = [...new Set([...previousAttendees, ...form.attendees.split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean)])];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || locked || !selectedConnection?.connected || !writer?.canWrite || writer.protectedReadOnly || unresolved) return;
    if (form.projectId && !projects.some(project => project.id === form.projectId)) { notice(t("Das gewählte Projekt liegt nicht im aktuellen Filter. Wähle ein verfügbares Projekt oder kehre zum ursprünglichen Filter zurück.", "The selected project is outside the current filter. Choose an available project or return to the original filter.", "El proyecto seleccionado no está en el filtro actual. Elige uno disponible o vuelve al filtro anterior.")); return; }
    const startsAtISO = selectedInstant(startCandidates, form.startInstant);
    const endsAtISO = selectedInstant(endCandidates, form.endInstant);
    if (!startsAtISO || !endsAtISO || Date.parse(endsAtISO) <= Date.parse(startsAtISO)) { notice(t("Prüfe Beginn, Ende und Zeitzone. Nicht vorhandene Uhrzeiten sind ungültig; doppelte Uhrzeiten benötigen eine Auswahl.", "Check start, end and time zone. Missing clock times are invalid; repeated times require a choice.", "Revisa inicio, fin y zona horaria. Las horas inexistentes no son válidas y las repetidas requieren una selección.")); return; }
    const attendees = form.attendees.split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean).map(email => ({ email, name: form.attendeeNames[email] ?? "" }));
    if (attendees.length > 10 || attendees.some(attendee => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendee.email)) || ((attendees.length > 0 || previousAttendees.length > 0) && !form.invitationsConfirmed)) { notice(t("Prüfe die Empfänger (höchstens zehn) und bestätige den Einladungsversand ausdrücklich.", "Check recipients (at most ten) and explicitly confirm invitations.", "Revisa los destinatarios (máximo diez) y confirma expresamente las invitaciones.")); return; }
    const draft: PersonalCalendarDraft = { title: form.title.trim(), startsAt: startsAtISO, endsAt: endsAtISO, timeZone: form.timeZone, location: form.location.trim(), projectId: form.projectId || null, attendees };
    await send({ action: entry.editingId ? "update" : "create", ...(entry.editingId ? { eventId: entry.editingId, expectedVersion: entry.editingVersion } : { provider: form.provider }), event: draft, invitationsConfirmed: form.invitationsConfirmed });
  }
  function edit(event: PersonalCalendarEvent) {
    if (!event.canEdit || !confirmed(event) || event.origin !== "personal_standalone" || locked || pending) return;
    const value = event.event;
    store.update(scope, initial, previous => ({ ...previous, editingId: event.id, editingVersion: event.version, notice: "", form: { provider: event.provider, title: value.title, startsAt: wallInput(value.startsAt, value.timeZone), endsAt: wallInput(value.endsAt, value.timeZone), startInstant: value.startsAt, endInstant: value.endsAt, timeZone: value.timeZone, location: value.location, projectId: value.projectId ?? "", attendees: value.attendees.map(attendee => attendee.email).join("\n"), attendeeNames: Object.fromEntries(value.attendees.map(attendee => [attendee.email.toLowerCase(), attendee.name])), invitationsConfirmed: false } }));
    document.getElementById(`${headingId}-form`)?.focus();
  }
  function date(instant: string, timeZone: string) { try { return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(instant)); } catch { return "—"; } }
  function remoteDetails(remote: PersonalCalendarRemoteSnapshot) {
    return <><p className="break-words font-semibold">{remote.title}</p><p>{date(remote.startsAt, remote.timeZone)} – {date(remote.endsAt, remote.timeZone)} · {remote.timeZone}</p><p className="break-words">{remote.location}</p><p className="break-words">{remote.attendees.map(attendee => attendee.email).join(", ") || t("Keine Empfänger", "No recipients", "Sin destinatarios")}</p>{remote.cancelled ? <p>{t("Beim Anbieter abgesagt", "Cancelled at the provider", "Cancelado en el proveedor")}</p> : null}</>;
  }

  return <section id="personal-calendar-workspace" aria-labelledby={headingId} className={`${panel} grid gap-5`} tabIndex={-1}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h3 id={headingId} className="text-2xl font-semibold">{t("Persönlicher Kalender", "Personal calendar", "Calendario personal")}</h3><p id={helpId} className="mt-2 max-w-3xl text-sm text-stone-600">{t("Verwalte hier angelegte persönliche Termine in deinem ausdrücklich verbundenen Konto. Buchungen bleiben in der Terminbuchung. Externe Änderungen werden erst nach Prüfung übernommen.", "Manage personal events created here in your explicitly connected account. Bookings stay in appointment booking. External changes are imported only after review.", "Gestiona aquí los eventos personales creados en tu cuenta conectada. Las reservas permanecen en su propio apartado; los cambios externos requieren revisión.")}</p></div><button className={button} disabled={busy} type="button" onClick={() => setRefresh(value => value + 1)}>{t("Ansicht aktualisieren", "Refresh view", "Actualizar vista")}</button></header>
    {loaded.scope === resourceKey && loaded.error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-900">{errorText(loaded.error)}</p> : !data ? <p role="status">{t("Kalender wird geladen …", "Loading calendar …", "Cargando calendario …")}</p> : null}
    {entry.notice ? <p role="status" className="rounded-md bg-blue-50 p-3 text-sm">{entry.notice}</p> : null}
    {data && otherPending ? <p role="status" className="rounded-md bg-amber-50 p-3 text-sm">{t("Ein anderer persönlicher Kalenderkontext enthält einen offenen Vorgang. Kehre zu diesem Kontext zurück, um ihn zu prüfen; seine Eingaben werden hier nicht übernommen.", "Another personal calendar context has a pending operation. Return to that context to check it; its inputs are not copied here.", "Otro contexto de calendario personal tiene una operación pendiente. Vuelve a ese contexto para comprobarla; sus datos no se copian aquí.")}</p> : null}
    {pending ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3"><p role="status">{pending.phase === "running" ? t("Vorgang wird geprüft …", "Checking operation …", "Comprobando operación …") : unknownMessage}</p><button className={`${button} mt-2`} disabled={busy} type="button" onClick={() => void send()}>{t("Denselben Vorgang erneut prüfen", "Check the same operation again", "Comprobar la misma operación")}</button></div> : null}
    <div className="grid gap-4 lg:grid-cols-2">{providers.map(provider => {
      const connection = data?.connections.find(value => value.provider === provider);
      const chosen = selection[provider] ?? { writeCalendarId: connection?.writeCalendarId ?? "", conflictCalendarIds: connection?.conflictCalendarIds ?? [] };
      return <article key={provider} className="min-w-0 rounded-md border border-stone-200 p-4"><h4 className="font-semibold">{provider === "microsoft" ? "Microsoft Outlook" : "Google Kalender"}</h4><p className="mt-1 break-words text-sm">{!data ? (loaded.error ? t("Verbindungsstatus nicht verfügbar", "Connection status unavailable", "Estado de conexión no disponible") : t("Verbindungsstatus wird geladen …", "Loading connection status …", "Cargando el estado de conexión …")) : connection?.connected ? connection.accountLabel || t("Verbundenes Konto", "Connected account", "Cuenta conectada") : t("Nicht verbunden", "Not connected", "Sin conexión")}</p><div className="mt-3 flex flex-wrap gap-2"><a className={button} href={`/api/crm/personal-calendar/connect/${provider}?workspaceId=${encodeURIComponent(workspaceId)}`}>{connection?.connected ? t("Erneut anmelden", "Reconnect", "Volver a conectar") : t("Persönliches Konto verbinden", "Connect personal account", "Conectar cuenta personal")}</a><button className={button} disabled={locked || Boolean(pending) || !connection?.connected} type="button" onClick={() => void send({ action: "refresh_calendars", provider })}>{t("Kalender abrufen", "Fetch calendars", "Consultar calendarios")}</button></div>
        {connection?.connected ? <fieldset disabled={locked || Boolean(pending)} className="mt-3 grid gap-3"><label className="grid gap-1 text-sm">{t("Schreibkalender", "Write calendar", "Calendario de escritura")}<select className={field} value={chosen.writeCalendarId} onChange={event => setSelection(previous => ({ ...previous, [provider]: { ...chosen, writeCalendarId: event.target.value } }))}><option value="">{t("Kalender auswählen", "Choose calendar", "Seleccionar calendario")}</option>{connection.calendars.filter(calendar => calendar.canWrite && !calendar.protectedReadOnly).map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label><div className="grid gap-1 text-sm"><p>{t("Kalender zur Konfliktprüfung", "Calendars for conflict checks", "Calendarios para comprobar conflictos")}</p>{connection.calendars.filter(calendar => calendar.canRead).map(calendar => <label key={calendar.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={chosen.conflictCalendarIds.includes(calendar.id)} onChange={event => setSelection(previous => ({ ...previous, [provider]: { ...chosen, conflictCalendarIds: event.target.checked ? [...chosen.conflictCalendarIds, calendar.id] : chosen.conflictCalendarIds.filter(id => id !== calendar.id) } }))}/><span className="break-words">{calendar.name}{calendar.protectedReadOnly || !calendar.canWrite ? ` · ${t("nur lesen", "read only", "solo lectura")}` : ""}</span></label>)}</div><button className={button} disabled={!chosen.writeCalendarId} type="button" onClick={() => void send({ action: "select_calendar", provider, ...chosen })}>{t("Kalenderauswahl speichern", "Save calendar selection", "Guardar selección")}</button></fieldset> : null}</article>;
    })}</div>
    <p className="text-sm text-stone-600">{t("Serientermine werden hier nicht angelegt oder bearbeitet. Wiederkehrende Belegtzeiten können bei der Verfügbarkeit berücksichtigt werden; das ist keine Serienverwaltung.", "Recurring events cannot be created or edited here. Recurring busy instances may be used in availability checks; this is not series management.", "Aquí no se crean ni editan series. Las instancias ocupadas recurrentes pueden comprobarse para la disponibilidad; esto no permite gestionar series.")}</p>
    <form onSubmit={event => void submit(event)} aria-describedby={helpId} className="grid gap-3 rounded-md bg-stone-50 p-4"><h4 id={`${headingId}-form`} tabIndex={-1} className="font-semibold">{entry.editingId ? t("Persönlichen Termin bearbeiten", "Edit personal event", "Editar evento personal") : t("Persönlichen Termin anlegen", "Create personal event", "Crear evento personal")}</h4><fieldset disabled={locked || Boolean(pending) || !data || Boolean(unresolved)} className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">{t("Anbieter", "Provider", "Proveedor")}<select className={field} value={form.provider} disabled={Boolean(entry.editingId)} onChange={event => update({ provider: event.target.value as Provider })}>{providers.map(provider => <option key={provider} value={provider}>{provider === "microsoft" ? "Microsoft Outlook" : "Google Kalender"}</option>)}</select></label><label className="grid gap-1 text-sm">{t("Projekt", "Project", "Proyecto")}<select className={field} value={form.projectId} disabled={Boolean(entry.editingId)} onChange={event => update({ projectId: event.target.value })}><option value="">{t("Ohne Projekt", "No project", "Sin proyecto")}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="grid gap-1 text-sm sm:col-span-2">{t("Titel", "Title", "Título")}<input className={field} required maxLength={200} value={form.title} onChange={event => update({ title: event.target.value })}/></label><label className="grid gap-1 text-sm">{t("Beginn", "Start", "Inicio")}<input className={field} required type="datetime-local" value={form.startsAt} onChange={event => update({ startsAt: event.target.value, startInstant: "" })}/></label><label className="grid gap-1 text-sm">{t("Ende", "End", "Fin")}<input className={field} required type="datetime-local" value={form.endsAt} onChange={event => update({ endsAt: event.target.value, endInstant: "" })}/></label><label className="grid gap-1 text-sm">{t("Zeitzone für Beginn und Ende", "Time zone for start and end", "Zona horaria del inicio y fin")}<input className={field} required maxLength={100} value={form.timeZone} onChange={event => update({ timeZone: event.target.value, startInstant: "", endInstant: "" })}/></label><label className="grid gap-1 text-sm">{t("Ort", "Location", "Lugar")}<input className={field} maxLength={500} value={form.location} onChange={event => update({ location: event.target.value })}/></label>{([[startCandidates, "startInstant", form.startInstant, t("Beginn: doppelte Uhrzeit auswählen", "Start: choose repeated clock time", "Inicio: elige la hora repetida")], [endCandidates, "endInstant", form.endInstant, t("Ende: doppelte Uhrzeit auswählen", "End: choose repeated clock time", "Fin: elige la hora repetida")]] as const).map(([candidates, key, selected, label]) => candidates.length > 1 ? <label key={key} className="grid gap-1 text-sm">{label}<select className={field} required value={candidates.find(value => Math.floor(Date.parse(value) / 60_000) === Math.floor(Date.parse(selected) / 60_000)) ?? ""} onChange={event => update({ [key]: event.target.value })}><option value="">{t("Vorkommen wählen", "Choose occurrence", "Elegir aparición")}</option>{candidates.map(value => <option key={value} value={value}>{new Intl.DateTimeFormat(language, { timeZone: form.timeZone, timeStyle: "long" }).format(new Date(value))} · {value}</option>)}</select></label> : null)}<label className="grid gap-1 text-sm sm:col-span-2">{t("Empfänger: eine E-Mail-Adresse pro Zeile, höchstens zehn", "Recipients: one email address per line, at most ten", "Destinatarios: un correo por línea, máximo diez")}<textarea className={field} rows={3} maxLength={3500} value={form.attendees} onChange={event => update({ attendees: event.target.value, invitationsConfirmed: false })}/></label>{invitationRecipients.length > 0 ? <p className="break-words text-sm sm:col-span-2">{t("Benachrichtigungen können bisherige und neue Teilnehmer erreichen:", "Notifications may reach previous and new participants:", "Las notificaciones pueden llegar a participantes anteriores y nuevos:")} {invitationRecipients.join(", ")}</p> : null}{invitationRecipients.length > 0 ? <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.invitationsConfirmed} onChange={event => update({ invitationsConfirmed: event.target.checked })}/>{t("Ich bestätige den Versand der Terminbenachrichtigung an diese Empfänger.", "I confirm sending the event notification to these recipients.", "Confirmo el envío de la notificación a estos destinatarios.")}</label> : null}<div className="flex flex-wrap gap-2 sm:col-span-2"><button className={button} disabled={!selectedConnection?.connected || !writer?.canWrite || writer.protectedReadOnly} type="submit">{entry.editingId ? t("Änderung prüfen und speichern", "Check and save change", "Comprobar y guardar cambio") : t("Termin prüfen und anlegen", "Check and create event", "Comprobar y crear evento")}</button>{entry.editingId ? <button className={button} type="button" onClick={() => store.update(scope, initial, previous => ({ ...previous, form: initial.form, editingId: null, editingVersion: null, notice: "" }))}>{t("Bearbeitung verlassen", "Leave editing", "Salir de la edición")}</button> : null}</div></fieldset>{unresolved ? <p role="status" className="text-sm">{t("Ein erfasster Vorgang ist noch offen. Gleiche zuerst seinen Status ab.", "A recorded operation is still open. Reconcile its status first.", "Hay una operación pendiente. Comprueba primero su estado.")}</p> : null}</form>
    <div className="grid gap-3"><h4 className="text-lg font-semibold">{t("Hier angelegte persönliche Termine", "Personal events created here", "Eventos personales creados aquí")}</h4>{data && data.events.length === 0 ? <p>{t("Noch keine persönlichen Termine erfasst.", "No personal events recorded yet.", "Todavía no hay eventos personales registrados.")}</p> : null}{data?.events.map(event => {
      const value = event.event;
      const states: Record<string, string> = { processing: t("In Bearbeitung", "Processing", "En proceso"), uncertain: t("Ergebnis unklar", "Outcome unknown", "Resultado pendiente"), synced: confirmed(event) ? t("Beim Anbieter nachgewiesen", "Verified with provider", "Verificado con proveedor") : t("Nachweis fehlt – Abgleich erforderlich", "Verification missing – reconcile required", "Falta verificación; comprueba el estado"), conflict: t("Konflikt – Vergleich prüfen", "Conflict – review comparison", "Conflicto; revisa la comparación"), cancelled: !event.providerEventId ? t("Lokaler Entwurf verworfen", "Local draft discarded", "Borrador local descartado") : event.remoteSnapshot?.cancelled ? t("Absage nachgewiesen", "Cancellation verified", "Cancelación verificada") : t("Absage noch nicht nachgewiesen", "Cancellation not yet verified", "Cancelación aún no verificada"), failed: t("Nicht abgeschlossen", "Not completed", "No completado") };
      return <article key={event.id} className="rounded-md border border-stone-200 p-4"><div className="flex flex-wrap justify-between gap-2"><h5 className="break-words font-semibold">{value.title}</h5><p className="text-sm font-semibold">{states[event.state] ?? t("Unbekannter Zustand", "Unknown state", "Estado desconocido")}</p></div><p className="mt-1 text-sm">{date(value.startsAt, value.timeZone)} – {date(value.endsAt, value.timeZone)} · {value.timeZone}</p><p className="mt-1 break-words text-sm">{value.location}</p><p className="mt-1 break-words text-sm">{value.attendees.map(attendee => attendee.email).join(", ")}</p>{event.remoteSnapshot && event.state === "conflict" ? <div className="mt-3 grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"><h6 className="font-semibold">{t("Beim Anbieter gelesener Stand", "State read from the provider", "Estado leído del proveedor")}</h6>{remoteDetails(event.remoteSnapshot)}<p>{t("Übernehmen aktualisiert den gespeicherten Termin; es überschreibt keine Anbieteränderung.", "Import updates the stored event; it does not overwrite the provider change.", "Importar actualiza el evento guardado; no sobrescribe el cambio del proveedor.")}</p><button className={button} disabled={locked || Boolean(pending) || !event.canImport || (!event.remoteSnapshot.cancelled && !event.remoteSnapshot.etag)} type="button" onClick={() => void send({ action: "import_remote", eventId: event.id, expectedVersion: event.version, remoteEtag: event.remoteSnapshot!.etag, invitationsConfirmed: false })}>{event.remoteSnapshot.cancelled ? t("Externe Absage übernehmen", "Import external cancellation", "Importar cancelación externa") : t("Diesen geprüften Stand übernehmen", "Import this reviewed state", "Importar este estado revisado")}</button></div> : null}<div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={locked || Boolean(pending)} type="button" onClick={() => void send({ action: "refresh", eventId: event.id, expectedVersion: event.version, invitationsConfirmed: false })}>{t("Beim Anbieter abgleichen", "Reconcile with provider", "Comprobar con proveedor")}</button><button className={button} disabled={locked || Boolean(pending) || (!event.canEdit || !confirmed(event))} type="button" onClick={() => edit(event)}>{t("Bearbeiten", "Edit", "Editar")}</button><button className={button} disabled={locked || Boolean(pending) || !event.canCancel || (Boolean(event.providerEventId) && value.attendees.length > 0 && !cancellationConfirmed[`${event.id}:${event.version}`])} type="button" onClick={() => void send({ action: "cancel", eventId: event.id, expectedVersion: event.version, invitationsConfirmed: cancellationConfirmed[`${event.id}:${event.version}`] ?? false })}>{event.state === "failed" && !event.providerEventId ? t("Lokalen Entwurf verwerfen", "Discard local draft", "Descartar borrador local") : t("Termin absagen", "Cancel event", "Cancelar evento")}</button></div>{value.attendees.length > 0 && event.canCancel && event.providerEventId ? <label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={locked || Boolean(pending)} checked={cancellationConfirmed[`${event.id}:${event.version}`] ?? false} onChange={change => setCancellationConfirmed(previous => ({ ...previous, [`${event.id}:${event.version}`]: change.target.checked }))}/>{t("Absagebenachrichtigung an die oben genannten Empfänger bestätigen.", "Confirm cancellation notification to the recipients listed above.", "Confirmar la notificación de cancelación a los destinatarios indicados.")}</label> : null}</article>;
    })}</div>
  </section>;
}
