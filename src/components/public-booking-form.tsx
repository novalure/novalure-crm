"use client";

import { useEffect, useRef, useState } from "react";
import type { BookingChannel, PublicBookingPublication, PublicBookingRecord } from "@/lib/booking/publication-types";
import type { LanguageCode } from "@/lib/language-runtime";
import { validatedBookingFrameOrigin } from "@/lib/booking/public-frame-policy";

export type PublicBookingReceipt = { booking: PublicBookingRecord; sessionToken: string };
export type PublicBookingFormProps = {
  publicId: string;
  channel?: Extract<BookingChannel, "link" | "inline" | "popup" | "form">;
  initialLanguage?: LanguageCode;
  initialPublication?: PublicBookingPublication;
  embeddedInForm?: boolean;
  onBooked?: (receipt: PublicBookingReceipt) => void;
  onCleared?: () => void;
};
type Slot = { startsAt: string; endsAt: string };
type Availability = { slots: Slot[]; timeZone: string; durationMinutes: number; requestFallback?: boolean; travelIssues?: string[] };
type Session = { token: string; expiresAt: string; typeId: string; language: LanguageCode };
type Attempt = { key: string; fingerprint: string; bookingId?: string };
type FrameState = { allowed: boolean; origin: string | null; instanceId: string | null };
const field = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600 disabled:bg-slate-100";
const button = "inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600";
const secondary = "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600";
const copy = {
  de: {
    loading: "Terminbuchung wird geladen …", unavailable: "Diese Terminbuchung ist derzeit nicht verfügbar. Bitte kontaktieren Sie das Unternehmen direkt.", type: "Terminart", date: "Datum", location: "Vollständige Besuchsadresse", addressConsent: "Ich bestätige diese eindeutige Adresse für den Besuch.", addressHelp: "Freie Zeiten werden erst nach Bestätigung der Adresse und erforderlicher Fahrtprüfung angeboten.", check: "Freie Zeiten anzeigen", choose: "Freie Startzeit auswählen", noSlots: "An diesem Tag sind keine passenden Zeiten verfügbar. Bitte einen anderen Tag wählen.", fallback: "Für einige Zeiten konnten Ort oder notwendige Fahrt nicht sicher geprüft werden. Bitte einen anderen Tag wählen oder einen Terminwunsch direkt beim Unternehmen anfragen.", name: "Ihr Name", email: "Ihre E-Mail-Adresse", contact: "Ihre Kontaktdaten", summary: "Ihre Auswahl", timeZone: "Terminzeitzone", duration: "Dauer", minutes: "Minuten", consent: "Ich möchte diesen Termin zu den angezeigten Angaben verbindlich buchen.", confirm: "Termin verbindlich buchen", confirming: "Buchung wird geprüft …", held: "Die Zeit ist reserviert. Bitte die verbindliche Bestätigung abschließen.", confirmHeld: "Reservierung verbindlich bestätigen", confirmed: "Ihr Termin ist bestätigt.", processing: "Das Ergebnis ist noch nicht abschließend bekannt. Bitte den Status prüfen; keine zweite Buchung anlegen.", status: "Buchungsstatus prüfen", statusMissing: "Noch keine abgeschlossene Buchung gefunden. Eine erneute Bestätigung verwendet denselben Vorgang.", pendingVideo: "Ihr Videolink wird noch vom Anbieter erstellt. Sie können den Status erneut prüfen.", video: "An Videokonferenz teilnehmen", messages: "Nachrichten", scheduled: "Geplant", accepted: "Vom Anbieter angenommen", notRequested: "Nicht angefordert", delivered: "Zugestellt", uncertain: "Versandstatus ungeklärt", failed: "Fehlgeschlagen", reschedule: "Termin umbuchen", cancel: "Termin absagen", rescheduleConsent: "Ich möchte meinen Termin auf die ausgewählte Zeit umbuchen.", rescheduleConfirm: "Umbuchung bestätigen", cancelConsent: "Ich möchte diesen Termin absagen.", cancelConfirm: "Absage bestätigen", cancelled: "Ihr Termin wurde abgesagt.", rescheduled: "Ihr Termin wurde umgebucht.", back: "Zurück", newChoice: "Neue Auswahl beginnen", close: "Schließen", invalidContact: "Bitte Ihren Namen und eine gültige E-Mail-Adresse eingeben.", consentRequired: "Bitte die Angaben prüfen und die gewünschte Aktion ausdrücklich bestätigen.", bookingError: "Die Aktion konnte nicht abgeschlossen werden. Bitte den Status prüfen oder das Unternehmen kontaktieren.", slotUnavailable: "Diese Zeit ist inzwischen belegt. Bitte die Verfügbarkeit erneut prüfen.", sessionExpired: "Diese Buchungssitzung ist abgelaufen. Bitte die Seite neu laden; eine bestehende Buchung bleibt erhalten.", deniedFrame: "Die Einbettung ist für diese Website nicht freigegeben. Bitte den Buchungslink direkt öffnen oder das Unternehmen kontaktieren.", reload: "Seite neu laden", language: "Sprache", states: { held: "Reserviert", expired: "Reservierung abgelaufen", processing: "In Bearbeitung", uncertain: "Ausgang ungeklärt", confirmed: "Bestätigt", cancelled: "Abgesagt", conflict: "Prüfung durch das Unternehmen erforderlich" }, kinds: { phone: "Telefontermin", teams: "Microsoft Teams", meet: "Google Meet", office: "Termin im Büro", onsite: "Kundenbesuch / Besichtigung" },
  },
  en: {
    loading: "Loading appointment booking …", unavailable: "Appointment booking is currently unavailable. Please contact the company directly.", type: "Appointment type", date: "Date", location: "Full visit address", addressConsent: "I confirm this unambiguous address for the visit.", addressHelp: "Available times are offered after the address and any required travel checks have been confirmed.", check: "Show available times", choose: "Choose an available start time", noSlots: "No suitable times are available on this day. Please choose another day.", fallback: "The location or required journey could not be verified for some times. Choose another day or contact the company to request an appointment.", name: "Your name", email: "Your email address", contact: "Your contact details", summary: "Your selection", timeZone: "Appointment time zone", duration: "Duration", minutes: "minutes", consent: "I want to book this appointment with the details shown.", confirm: "Confirm appointment booking", confirming: "Checking your booking …", held: "This time is reserved. Please complete the booking confirmation.", confirmHeld: "Confirm reserved appointment", confirmed: "Your appointment is confirmed.", processing: "The outcome is not final yet. Check its status; do not create a second booking.", status: "Check booking status", statusMissing: "No completed booking was found yet. Confirming again uses the same operation.", pendingVideo: "The provider is still preparing your video link. You can check the status again.", video: "Join video meeting", messages: "Messages", scheduled: "Scheduled", accepted: "Accepted by provider", notRequested: "Not requested", delivered: "Delivered", uncertain: "Delivery status unknown", failed: "Failed", reschedule: "Reschedule appointment", cancel: "Cancel appointment", rescheduleConsent: "I want to reschedule my appointment to the selected time.", rescheduleConfirm: "Confirm rescheduling", cancelConsent: "I want to cancel this appointment.", cancelConfirm: "Confirm cancellation", cancelled: "Your appointment has been cancelled.", rescheduled: "Your appointment has been rescheduled.", back: "Back", newChoice: "Start a new selection", close: "Close", invalidContact: "Enter your name and a valid email address.", consentRequired: "Check the details and explicitly confirm your intended action.", bookingError: "The action could not be completed. Check the status or contact the company.", slotUnavailable: "This time is no longer available. Check availability again.", sessionExpired: "This booking session expired. Reload the page; an existing booking is preserved.", deniedFrame: "This website is not approved to embed the booking form. Open the booking link directly or contact the company.", reload: "Reload page", language: "Language", states: { held: "Reserved", expired: "Reservation expired", processing: "Processing", uncertain: "Outcome unknown", confirmed: "Confirmed", cancelled: "Cancelled", conflict: "The company needs to review this booking" }, kinds: { phone: "Phone appointment", teams: "Microsoft Teams", meet: "Google Meet", office: "Office appointment", onsite: "Customer visit / viewing" },
  },
};

class PublicBookingRequestError extends Error { constructor(public code: string, public status: number) { super(code); } }
async function publicRequest<T>(action: string, payload?: unknown, token?: string): Promise<T> {
  const response = await fetch(`/api/public/booking/${action}`, { method: payload === undefined ? "GET" : "POST", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(20_000), headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new PublicBookingRequestError(typeof value.error === "string" ? value.error : "BOOKING_UNAVAILABLE", response.status);
  return value as T;
}

export function publicBookingParentAllowed(parentOrigin: string, ownOrigin: string, allowedOrigins: string[]) {
  const origin = validatedBookingFrameOrigin(parentOrigin, true);
  return !!origin && (origin === ownOrigin || allowedOrigins.includes(origin));
}

export function PublicBookingForm(props: PublicBookingFormProps) {
  return <PublicBookingFormRuntime key={`${props.publicId}:${props.channel ?? "link"}`} {...props} />;
}

function PublicBookingFormRuntime({ publicId, channel = "link", initialLanguage = "de", initialPublication, embeddedInForm = false, onBooked, onCleared }: PublicBookingFormProps) {
  const [publication, setPublication] = useState<PublicBookingPublication | null>(initialPublication ?? null);
  const [language, setLanguage] = useState<LanguageCode>(initialPublication?.language === "de" || initialPublication?.language === "en" ? initialPublication.language : initialLanguage);
  const text = copy[language];
  const [typeId, setTypeId] = useState(initialPublication?.types[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [booking, setBooking] = useState<PublicBookingRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [management, setManagement] = useState<"reschedule" | "cancel" | null>(null);
  const [frame, setFrame] = useState<FrameState | null>(null);
  const session = useRef<Session | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const chosenType = publication?.types.find(item => item.id === typeId);
  const zone = booking?.timeZone ?? availability?.timeZone ?? chosenType?.timeZone ?? "Europe/Vienna";
  const locked = !!booking && !["cancelled", "expired"].includes(booking.state) || unknown;

  useEffect(() => {
    let active = true;
    if (!initialPublication) publicRequest<PublicBookingPublication>(encodeURIComponent(publicId)).then(value => {
      if (!active) return;
      setPublication(value); setTypeId(value.types[0]?.id ?? "");
      if (value.language === "de" || value.language === "en") setLanguage(value.language);
    }).catch(() => { if (active) setError("PUBLICATION_UNAVAILABLE"); });
    return () => { active = false; };
  }, [initialPublication, publicId]);

  useEffect(() => {
    if (!publication) return;
    const standalone = window.parent === window;
    const params = new URLSearchParams(window.location.search), parentOrigin = params.get("parentOrigin") ?? "", instanceId = params.get("instanceId") ?? "";
    const permitted = standalone || publicBookingParentAllowed(parentOrigin, window.location.origin, publication.allowedOrigins) && /^[a-zA-Z0-9_-]{10,150}$/.test(instanceId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const receive = (event: MessageEvent) => {
      if (standalone || !permitted || event.source !== window.parent || event.origin !== parentOrigin || !event.data || typeof event.data !== "object") return;
      if (event.data.type !== "novalure.booking.initialize" || event.data.version !== 1 || event.data.instanceId !== instanceId) return;
      clearTimeout(timeout);
      setFrame({ allowed: true, origin: parentOrigin, instanceId });
      window.parent.postMessage({ type: "novalure.booking.ready", version: 1, instanceId }, parentOrigin);
    };
    window.addEventListener("message", receive);
    const rendered = requestAnimationFrame(() => {
      if (standalone) { setFrame({ allowed: true, origin: null, instanceId: null }); return; }
      if (!permitted) { setFrame({ allowed: false, origin: null, instanceId: null }); return; }
      setFrame({ allowed: false, origin: parentOrigin, instanceId });
      timeout = setTimeout(() => setFrame({ allowed: false, origin: null, instanceId: null }), 8000);
      window.parent.postMessage({ type: "novalure.booking.hello", version: 1, instanceId }, parentOrigin);
    });
    return () => { cancelAnimationFrame(rendered); clearTimeout(timeout); window.removeEventListener("message", receive); };
  }, [publication]);

  useEffect(() => {
    if (!frame?.allowed || !frame.origin || !frame.instanceId || !root.current) return;
    const parentOrigin = frame.origin, instanceId = frame.instanceId;
    const resize = () => window.parent.postMessage({ type: "novalure.booking.resize", version: 1, instanceId, height: Math.max(320, Math.min(1800, Math.ceil(root.current?.scrollHeight ?? 680) + 24)) }, parentOrigin);
    const observer = new ResizeObserver(resize); observer.observe(root.current); resize();
    return () => observer.disconnect();
  }, [frame]);

  function describeError(cause: unknown) {
    if (cause instanceof PublicBookingRequestError) {
      const code = cause.code.toLowerCase();
      if (code.includes("slot_unavailable") || code.includes("daily_limit")) return text.slotUnavailable;
      if (code.includes("session") || code.includes("token") || cause.status === 401) return text.sessionExpired;
    }
    return text.bookingError;
  }
  async function ensureSession() {
    if (!frame?.allowed || !chosenType) throw new Error("PUBLIC_BOOKING_NOT_READY");
    if (session.current && session.current.typeId === typeId && session.current.language === language && Date.parse(session.current.expiresAt) > Date.now() + 30_000) return session.current;
    if (locked && session.current) return session.current;
    const value = await publicRequest<{ token: string; expiresAt: string; publication: PublicBookingPublication }>("sessions", { publicId, channel, typeId, language });
    session.current = { token: value.token, expiresAt: value.expiresAt, typeId, language };
    return session.current;
  }
  function notifyConfirmed(row: PublicBookingRecord, token: string) {
    onBooked?.({ booking: row, sessionToken: token });
    if (channel === "form" && frame?.allowed && frame.origin && frame.instanceId) window.parent.postMessage({ type: "novalure.booking.confirmed", version: 1, instanceId: frame.instanceId, publicId, bookingId: row.id, sessionToken: token }, frame.origin);
  }
  function applyBooking(row: PublicBookingRecord | null) {
    setBooking(row);
    setUnknown(!!row && ["processing", "uncertain"].includes(row.state));
    if (row && attempt.current) attempt.current.bookingId = row.id;
    if (row?.state === "confirmed" && session.current) notifyConfirmed(row, session.current.token);
    if (row && ["cancelled", "expired"].includes(row.state)) {
      onCleared?.();
      if (channel === "form" && frame?.allowed && frame.origin && frame.instanceId) window.parent.postMessage({ type: "novalure.booking.cleared", version: 1, instanceId: frame.instanceId, publicId }, frame.origin);
    }
  }
  function resetSlots() { setAvailability(null); setSelected(""); setConsent(false); setMessage(""); setError(""); }
  async function readAvailability() {
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await ensureSession();
      const result = await publicRequest<Availability>("availability", { date, ...(chosenType?.locationRequired ? { location, locationConfirmed } : {}), ...(management === "reschedule" && booking ? { bookingId: booking.id } : {}) }, current.token);
      setAvailability(result); setSelected(""); setConsent(false);
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); }
  }
  function format(instant: string) { return new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(instant)); }
  function validContact() { return !!nameInput.current?.reportValidity() && !!emailInput.current?.reportValidity(); }
  async function confirm() {
    if (!consent) { setError(text.consentRequired); return; }
    if (!selected || !booking && !validContact()) { setError(text.invalidContact); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await ensureSession();
      const payload = { startsAt: selected, recipientEmail: email.trim(), recipientName: name.trim(), ...(chosenType?.locationRequired ? { location, locationConfirmed } : {}) };
      const fingerprint = JSON.stringify(payload);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      let row = booking;
      if (!row || row.state === "expired" || row.state === "cancelled") row = (await publicRequest<{ booking: PublicBookingRecord }>("hold", { ...payload, idempotencyKey: attempt.current.key }, current.token)).booking;
      applyBooking(row);
      if (row.state === "held") { row = (await publicRequest<{ booking: PublicBookingRecord }>("confirm", { bookingId: row.id, consent: true }, current.token)).booking; applyBooking(row); }
      if (row.state === "confirmed") setMessage(text.confirmed);
    } catch (cause) { setUnknown(!!attempt.current); setError(describeError(cause)); } finally { setBusy(false); }
  }
  async function status() {
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await ensureSession();
      const lookup = booking?.id ?? attempt.current?.bookingId;
      const result = await publicRequest<{ booking: PublicBookingRecord | null; pending?: boolean; unknown?: boolean }>("status", lookup ? { bookingId: lookup } : { idempotencyKey: attempt.current?.key }, current.token);
      applyBooking(result.booking); setUnknown(!!result.pending || !!result.unknown || !!result.booking && ["processing", "uncertain"].includes(result.booking.state));
      if (!result.booking) setMessage(text.statusMissing);
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); }
  }
  async function manage(action: "reschedule" | "cancel") {
    if (!booking || !consent || action === "reschedule" && !selected) { setError(text.consentRequired); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await ensureSession(), key = `${action}:${booking.id}:${selected}`;
      if (!actionKeys.current.has(key)) actionKeys.current.set(key, crypto.randomUUID());
      const result = await publicRequest<{ booking: PublicBookingRecord }>(action, { bookingId: booking.id, ...(action === "reschedule" ? { startsAt: selected } : {}), idempotencyKey: actionKeys.current.get(key), consent: true }, current.token);
      applyBooking(result.booking); setManagement(null); setConsent(false); setAvailability(null); setSelected("");
      setMessage(action === "cancel" ? result.booking.state === "cancelled" ? text.cancelled : text.processing : result.booking.state === "confirmed" ? text.rescheduled : text.processing);
    } catch (cause) { setUnknown(true); setError(describeError(cause)); } finally { setBusy(false); }
  }
  function restart() { setBooking(null); setUnknown(false); attempt.current = null; session.current = null; setManagement(null); resetSlots(); onCleared?.(); }

  if (!publication) return <p role={error ? "alert" : "status"} className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{error ? text.unavailable : text.loading}</p>;
  if (!publication.channels[channel]) return <p role="alert" className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{text.unavailable}</p>;
  if (!frame?.allowed) return <p role={frame && !frame.origin ? "alert" : "status"} className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{frame && !frame.origin ? text.deniedFrame : text.loading}</p>;
  const stateText = booking ? text.states[booking.state as keyof typeof text.states] ?? text.processing : "";
  const showSelection = !locked || management === "reschedule";
  const content = <div ref={root} lang={language} className="grid min-w-0 gap-5 text-slate-950" data-novalure-booking-form={publicId}>
    {publication.language === "auto" ? <label className="grid gap-1 text-sm sm:ml-auto sm:w-40">{text.language}<select className={field} disabled={busy || locked} value={language} onChange={event => { setLanguage(event.target.value as LanguageCode); session.current = null; resetSlots(); }}><option value="de">Deutsch</option><option value="en">English</option></select></label> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}{message || busy ? <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm">{busy ? text.confirming : message}</p> : null}
    {showSelection ? <fieldset disabled={busy} className="grid min-w-0 gap-4"><legend className="sr-only">{text.type}</legend>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">{text.type}<select className={field} disabled={locked} value={typeId} onChange={event => { setTypeId(event.target.value); session.current = null; setLocation(""); setLocationConfirmed(false); resetSlots(); }}>{publication.types.map(type => <option key={type.id} value={type.id}>{text.kinds[type.kind]} · {type.durationMinutes} {text.minutes}</option>)}</select></label><label className="grid gap-1 text-sm">{text.date}<input className={field} type="date" required value={date} onChange={event => { setDate(event.target.value); resetSlots(); }} /></label></div>
      <p className="text-sm text-slate-600">{text.timeZone}: <strong>{zone}</strong></p>
      {chosenType?.locationRequired ? <div className="grid gap-2 rounded-lg bg-slate-50 p-3"><label className="grid gap-1 text-sm">{text.location}<input className={field} required maxLength={500} value={location} disabled={locked} autoComplete="street-address" onChange={event => { setLocation(event.target.value); setLocationConfirmed(false); resetSlots(); }} /></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={locationConfirmed} disabled={locked || !location.trim()} onChange={event => { setLocationConfirmed(event.target.checked); resetSlots(); }} />{text.addressConsent}</label><p className="text-xs text-slate-600">{text.addressHelp}</p></div> : null}
      <button className={secondary} type="button" disabled={!date || !chosenType || chosenType.locationRequired && (!location.trim() || !locationConfirmed)} onClick={() => void readAvailability()}>{text.check}</button>
      {availability ? <div className="grid gap-3"><div role="group" aria-label={text.choose} className="flex flex-wrap gap-2">{availability.slots.map(slot => <button key={slot.startsAt} className={selected === slot.startsAt ? button : secondary} type="button" aria-pressed={selected === slot.startsAt} onClick={() => { setSelected(slot.startsAt); setConsent(false); setError(""); }}>{format(slot.startsAt)}</button>)}</div>{availability.slots.length === 0 ? <p className="text-sm text-slate-600">{text.noSlots}</p> : null}{availability.requestFallback ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{text.fallback}</p> : null}</div> : null}
    </fieldset> : null}
    {selected && !booking ? <fieldset disabled={busy || unknown} className="grid min-w-0 gap-3"><legend className="mb-2 font-semibold">{text.contact}</legend><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">{text.name}<input ref={nameInput} className={field} required value={name} maxLength={200} autoComplete="name" onChange={event => { setName(event.target.value); setConsent(false); }} /></label><label className="grid gap-1 text-sm">{text.email}<input ref={emailInput} className={field} required type="email" value={email} maxLength={254} autoComplete="email" onChange={event => { setEmail(event.target.value); setConsent(false); }} /></label></div></fieldset> : null}
    {selected && (!booking || booking.state === "held" || management === "reschedule") ? <section className="rounded-lg border border-slate-200 bg-slate-50 p-4" aria-label={text.summary}><h2 className="font-semibold">{text.summary}</h2><p className="mt-2 text-sm">{chosenType ? text.kinds[chosenType.kind] : ""} · {format(selected)} · {zone}</p><p className="mt-1 text-sm">{text.duration}: {chosenType?.durationMinutes} {text.minutes}</p>{location || chosenType?.location ? <p className="mt-1 break-words text-sm">{location || chosenType?.location}</p> : null}{!management ? <p className="mt-1 break-words text-sm">{name} · {email}</p> : null}<label className="mt-3 flex min-h-11 items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={busy || unknown} checked={consent} onChange={event => setConsent(event.target.checked)} />{management === "reschedule" ? text.rescheduleConsent : text.consent}</label><button className={`${button} mt-3`} type="button" disabled={busy || unknown || !consent || !management && (!name.trim() || !email.trim())} onClick={() => void (management === "reschedule" ? manage("reschedule") : confirm())}>{management === "reschedule" ? text.rescheduleConfirm : booking?.state === "held" ? text.confirmHeld : text.confirm}</button></section> : null}
    {booking ? <section className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4" aria-label={text.status}><h2 className="font-semibold">{stateText}</h2><p className="text-sm">{text.kinds[booking.kind]} · {format(booking.startsAt)} · {booking.timeZone}</p>{booking.location ? <p className="break-words text-sm">{booking.location}</p> : null}{booking.state === "held" ? <p className="text-sm">{text.held}</p> : null}{booking.state === "confirmed" && booking.videoUrl && /^https:\/\//.test(booking.videoUrl) ? <a className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 underline" href={booking.videoUrl} target="_blank" rel="noopener noreferrer">{text.video}</a> : booking.videoStatus === "pending" ? <p className="text-sm">{text.pendingVideo}</p> : null}<p className="text-sm">{text.messages}: {booking.notificationStatus === "not_requested" ? text.notRequested : ["pending", "planned"].includes(booking.notificationStatus) ? text.scheduled : ["sent", "accepted"].includes(booking.notificationStatus) ? text.accepted : booking.notificationStatus === "delivered" ? text.delivered : booking.notificationStatus === "failed" ? text.failed : text.uncertain}</p><div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => void status()}>{text.status}</button>{booking.state === "confirmed" && !management ? <><button type="button" className={secondary} disabled={busy} onClick={() => { setManagement("reschedule"); setConsent(false); setAvailability(null); setSelected(""); setLocation(booking.location); setLocationConfirmed(true); }}>{text.reschedule}</button><button type="button" className={secondary} disabled={busy} onClick={() => { setManagement("cancel"); setConsent(false); }}>{text.cancel}</button></> : null}{["cancelled", "expired"].includes(booking.state) ? <button className={secondary} type="button" onClick={restart}>{text.newChoice}</button> : null}</div></section> : null}
    {unknown ? <section className="grid gap-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-900"><p>{text.processing}</p><button className={secondary} type="button" disabled={busy} onClick={() => void status()}>{text.status}</button></section> : null}
    {management === "cancel" ? <section className="rounded-lg border border-red-200 bg-red-50 p-4"><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />{text.cancelConsent}</label><div className="mt-3 flex flex-wrap gap-2"><button className={button} type="button" disabled={busy || !consent} onClick={() => void manage("cancel")}>{text.cancelConfirm}</button><button className={secondary} type="button" disabled={busy} onClick={() => { setManagement(null); setConsent(false); }}>{text.back}</button></div></section> : null}
    {management === "reschedule" ? <button type="button" className={secondary} disabled={busy} onClick={() => { setManagement(null); resetSlots(); }}>{text.back}</button> : null}
    {channel === "popup" && frame.origin && frame.instanceId ? <button type="button" className={secondary} onClick={() => window.parent.postMessage({ type: "novalure.booking.close", version: 1, instanceId: frame.instanceId }, frame.origin!)}>{text.close}</button> : null}
  </div>;
  return embeddedInForm ? content : <form onSubmit={event => event.preventDefault()} noValidate>{content}</form>;
}
