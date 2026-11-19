import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublicBookingForm } from "@/components/public-booking-form";
import { getLegacyBookingReplacement } from "@/lib/booking/legacy-routing";
import {
  getPublicMeetingAvailability,
  getPublicMeetingBookingActionState,
  getPublicMeetingPageSettings,
} from "@/lib/db/meeting-repositories";
import { getLocale } from "@/lib/i18n";
import { getPropertyBookingPageCopy as getPublicBookingPageCopy } from "@/lib/property-booking-copy";
import { buildPublicMeetingPath } from "@/lib/public-routing";
import { resolvePublicSiteLanguage as resolvePublicLanguage,type PublicLanguageCode } from "@/lib/public-language";
import { publicSubmissionControlFields } from "@/lib/public-submission-contract";
import { getPropertyBookingActionPageSettings,getPublicPropertyMeetingPageSettings,resolvePublicPropertyBookingContext } from "@/lib/property-booking-repository";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
} from "@/lib/security/public-submission-abuse";

type BookingPageProps = {
  slug: string;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  workspacePublicKey: string;
  propertyContext?: string;
};

type PublicMeetingAutomation = {
  allowCancel?: boolean;
  allowReschedule?: boolean;
  confirmationEnabled?: boolean;
  confirmationTitle?: string;
  reminderEnabled?: boolean;
  reminders?: Array<{ enabled?: boolean }>;
  requireCancelReason?: boolean;
};

type PublicMeetingCalendarConfig = {
  defaultMeetingProvider?: string;
  defaultProvider?: string;
};

type PublicMeetingShareConfig = {
  theme?: string;
};

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getBookingTitle(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getMeetingLabel(meeting: string, copy: ReturnType<typeof getPublicBookingPageCopy>) {
  if (meeting === "google-meet") return copy.meetingLabels.googleMeet;
  if (meeting === "manual-link") return copy.meetingLabels.manualLink;
  if (meeting === "phone") return copy.meetingLabels.phone;
  return copy.meetingLabels.microsoftTeams;
}

function getCalendarLabel(calendar: string, copy: ReturnType<typeof getPublicBookingPageCopy>) {
  if(calendar==='none')return 'CRM';
  return calendar === "google" ? copy.calendarLabels.google : copy.calendarLabels.microsoft;
}

function getStatusText(error: string, copy: ReturnType<typeof getPublicBookingPageCopy>) {
  return copy.status.errors[error as keyof typeof copy.status.errors] ?? copy.status.errors.fallback;
}

function formatMonth(dateKey: string, language: PublicLanguageCode, timeZone = "Europe/Vienna") {
  return new Intl.DateTimeFormat(language==="es"?"es-ES":getLocale(language), {
    month: "long",
    timeZone,
    year: "numeric",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function formatDateKey(value: string | Date, timeZone = "Europe/Vienna") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(value));
  const partByType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${partByType.year}-${partByType.month}-${partByType.day}`;
}

function formatDateTime(value: string | Date, language: PublicLanguageCode, timeZone = "Europe/Vienna") {
  return new Intl.DateTimeFormat(language==="es"?"es-ES":getLocale(language), {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(new Date(value));
}

function buildDateHref(input: {
  bookingId: string;
  calendar: string;
  date: string;
  meeting: string;
  mode: "booking" | "reschedule";
  language: PublicLanguageCode;
  slug: string;
  source: string;
  theme: string;
  token: string;
  workspacePublicKey: string;
  propertyContext?: string;
}) {
  const params = new URLSearchParams({
    calendar: input.calendar,
    date: input.date,
    meeting: input.meeting,
    lang: input.language,
    theme: input.theme,
    utm_source: input.source,
  });
  if(input.propertyContext)params.set('property_context',input.propertyContext);

  if (input.mode === "reschedule") {
    params.set("booking", input.bookingId);
    params.set("reschedule", "1");
    params.set("token", input.token);
  }

  return `${buildPublicMeetingPath({
    slug: input.slug,
    workspacePublicKey: input.workspacePublicKey,
  })}?${params.toString()}`;
}

export async function generatePublicBookingMetadata({
  searchParams,
  slug,
}: BookingPageProps): Promise<Metadata> {
  const query = searchParams ? await searchParams : {};
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    requestedLanguage: query.lang,
  });
  const copy = getPublicBookingPageCopy(language);

  return {
    description: copy.metadataDescription,
    title: copy.bookTitle(getBookingTitle(slug) || "Meeting"),
  };
}

export async function renderPublicBookingPage({
  searchParams,
  slug,
  workspacePublicKey,
}: BookingPageProps) {
  const query = searchParams ? await searchParams : {};
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    requestedLanguage: query.lang,
  });
  const copy = getPublicBookingPageCopy(language);
  const propertyContext=getQueryValue(query.property_context);
  const bookingId=getQueryValue(query.booking),token=getQueryValue(query.token);
  const actionPage=bookingId&&token?await getPropertyBookingActionPageSettings(bookingId,token).catch(()=>null):null;
  const savedPage = actionPage??(propertyContext?await getPublicPropertyMeetingPageSettings(propertyContext).catch(()=>null):await getPublicMeetingPageSettings({ slug, workspacePublicKey }));
  const propertyOffer=propertyContext?await resolvePublicPropertyBookingContext(propertyContext).catch(()=>null):null;
  const validPropertyOffer=propertyOffer?.meetingPageId===savedPage?.id&&propertyOffer?.workspaceId===savedPage?.workspaceId&&savedPage?.slug===slug&&savedPage?.workspacePublicKey===workspacePublicKey;
  const savedCalendar = (savedPage?.calendarIntegrations ?? {}) as PublicMeetingCalendarConfig;
  const savedShare = (savedPage?.shareConfig ?? {}) as PublicMeetingShareConfig;
  const savedAutomation = (savedPage?.automation ?? {}) as PublicMeetingAutomation;
  const calendar = propertyContext||actionPage?savedCalendar.defaultProvider??'none':getQueryValue(query.calendar, savedCalendar.defaultProvider ?? "microsoft");
  const meeting = propertyContext||actionPage?savedCalendar.defaultMeetingProvider??'manual-link':getQueryValue(query.meeting, savedCalendar.defaultMeetingProvider ?? "microsoft-teams");
  const theme = getQueryValue(query.theme, savedShare.theme ?? "light");
  const source = getQueryValue(query.utm_source, "crm");
  const requestedDate = getQueryValue(query.date) || undefined;
  const submitted = getQueryValue(query.submitted) === "1";
  const confirmed = getQueryValue(query.confirmed) === "1";
  const cancelled = getQueryValue(query.cancelled) === "1";
  const rescheduled = getQueryValue(query.rescheduled) === "1";
  const bookingError = getQueryValue(query.error);
  const queuedMessages = getQueryValue(query.queued, "0");
  const sentMessages = getQueryValue(query.sent, "0");
  const cancelMode = getQueryValue(query.cancel) === "1";
  const rescheduleMode = getQueryValue(query.reschedule) === "1";
  const actionState =
    bookingId && token
      ? await getPublicMeetingBookingActionState({ bookingId, token })
      : null;
  const replacement = savedPage?.id && savedPage.workspaceId ? await getLegacyBookingReplacement(savedPage.workspaceId, savedPage.id) : null;
  if (replacement && !cancelMode) {
    if (rescheduleMode && actionState) return <main lang={language} className="novalure-public-runtime mx-auto max-w-xl p-6">
      <h1>{language === "de" ? "Bestehenden Termin umbuchen" : language === "es" ? "Cambiar su cita existente" : "Reschedule your existing appointment"}</h1>
      <p>{language === "de" ? "Bitte kontaktieren Sie den Veranstalter zur Umbuchung dieses bestehenden Termins. Es wurde kein neuer Termin gebucht." : language === "es" ? "Contacte con la empresa para cambiar esta cita existente. No se ha reservado una cita nueva." : "Please contact the organizer to reschedule this existing appointment. No new appointment has been booked."}</p>
      <p>{actionState.title} · {formatDateTime(actionState.startsAt, language)}</p>
    </main>;
    if (!replacement.enabled || !replacement.channels.link) return <main lang={language} className="novalure-public-runtime mx-auto max-w-xl p-6">
      <h1>{language === "de" ? "Termin anfragen" : language === "es" ? "Solicitar una cita" : "Request an appointment"}</h1>
      <p>{language === "de" ? "Bitte kontaktieren Sie den Veranstalter für einen Termin. Für diese Terminseite sind derzeit keine Buchungszeiten freigegeben." : language === "es" ? "Contacte con la empresa para solicitar una cita. Esta página no ofrece horarios de reserva en este momento." : "Please contact the organizer to request an appointment. Booking times are currently unavailable for this appointment page."}</p>
    </main>;
    if (language === "es") return <main lang="es" className="novalure-public-runtime mx-auto grid max-w-xl gap-4 p-6">
      <h1 className="text-2xl font-semibold">Elegir el idioma de la reserva</h1>
      <p>Este formulario de reserva está disponible en alemán o inglés. El formulario de la empresa puede tener un idioma fijo. Elija el idioma con el que desea continuar; todavía no se ha reservado ninguna cita.</p>
      <div className="flex flex-wrap gap-3">
        <a className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 py-2 font-semibold" href={`/appointments/${encodeURIComponent(replacement.publicId)}?lang=en`} hrefLang="en">Solicitar formulario en inglés</a>
        <a className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 py-2 font-semibold" href={`/appointments/${encodeURIComponent(replacement.publicId)}?lang=de`} hrefLang="de">Solicitar formulario en alemán</a>
      </div>
    </main>;
    return <PublicBookingForm publicId={replacement.publicId} channel="link" initialLanguage={language} />;
  }
  const actionDate = actionState ? formatDateKey(actionState.startsAt) : undefined;
  const availability = await getPublicMeetingAvailability({
    propertyContext:propertyContext||undefined,
    bookingAction:actionPage?.bookingAction,
    date: requestedDate || (actionState ? actionDate : undefined),
    slug,
    workspacePublicKey,
  });
  const selectedDate = availability?.date ?? requestedDate ?? actionDate ?? new Date().toISOString().slice(0, 10);
  const selectedMonth = formatMonth(selectedDate, language, availability?.rules.timeZone);
  const availableSlots = availability?.slots.filter((slot) => slot.available) ?? [];
  const defaultSlot = availableSlots[0]?.time ?? "";
  const meetingLabel = getMeetingLabel(meeting, copy);
  const calendarLabel = getCalendarLabel(calendar, copy);
  const bookingTitle = savedPage?.title || getBookingTitle(slug) || "Pipeline Audit";
  const pageTitle = cancelMode
    ? copy.cancelTitle(bookingTitle)
    : rescheduleMode
      ? copy.rescheduleTitle(bookingTitle)
      : copy.bookTitle(bookingTitle);
  const pageDescription = cancelMode
    ? copy.descriptions.cancel
    : rescheduleMode
      ? copy.descriptions.reschedule
      : copy.descriptions.booking;
  const actionTimeZone = availability?.rules.timeZone ?? "Europe/Vienna";
  const actionDateTime = actionState ? formatDateTime(actionState.startsAt, language, actionTimeZone) : null;
  const propertyActionHref=(action:'cancel'|'reschedule')=>`${buildPublicMeetingPath({slug,workspacePublicKey})}?${new URLSearchParams({booking:bookingId,token,lang:language,property_context:propertyContext,[action]:'1'})}`;
  const isDark = theme === "dark";
  const activeReminderCount =
    savedAutomation.reminderEnabled && Array.isArray(savedAutomation.reminders)
      ? savedAutomation.reminders.filter((reminder) => reminder.enabled !== false).length
      : 0;
  const submissionProof = savedPage?.id && savedPage.workspaceId
    ? createPublicSubmissionProof({
        action: publicSubmissionActions.booking,
        scope: buildPublicSubmissionScope({
          resourceId: savedPage.id,
          resourceType: "meeting",
          workspaceId: savedPage.workspaceId,
        }),
      })
    : null;

  return (
    <main
      lang={language}
      className={`novalure-public-runtime min-h-screen px-4 py-8 ${
        isDark ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-950"
      }`}
    >
      <section className="mx-auto grid max-w-6xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl lg:grid-cols-[0.95fr_1.05fr]">
        <div className="bg-slate-950 p-6 text-white lg:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">
            {copy.eyebrow}
          </p>
          <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-tight sm:text-4xl">
            {pageTitle}
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300">
            {pageDescription}
          </p>
          {propertyContext&&<div className="mt-5 rounded-lg border border-white/15 p-4 text-sm"><p className="font-semibold">{validPropertyOffer?`${propertyOffer?.title} · ${propertyOffer?.unitNumber}`:language==='de'?'Besichtigungsangebot nicht verfügbar':language==='es'?'Visita no disponible':'Viewing offer unavailable'}</p><p className="mt-2 text-slate-300">{language==='de'?'Dies ist eine Terminanfrage. Der tatsächliche Teilnehmer und die Besichtigung werden persönlich geprüft und bestätigt. Ein Exposélink bestätigt keine Identität.':language==='es'?'Esto es una solicitud de cita. Un asesor revisará al participante y confirmará la visita. Un enlace al inmueble no verifica la identidad.':'This is an appointment request. An adviser will review the actual participant and confirm the viewing. A property link does not verify identity.'}</p></div>}

          <div className="mt-8 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">{copy.calendar}</p>
              <p className="mt-1 font-semibold">{calendarLabel}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">{copy.meeting}</p>
              <p className="mt-1 font-semibold">{meetingLabel}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">{copy.duration}</p>
              <p className="mt-1 font-semibold">
                {availability?.rules.durationMinutes ?? 30} {copy.minutes}
              </p>
            </div>
          </div>

          {actionState ? (
            <div className="mt-6 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <p className="font-semibold text-white">{actionState.title}</p>
              <p className="mt-1">{actionDateTime}</p>
              <p className="mt-1">{actionState.contactName}</p>
              <p className="mt-1 text-slate-300">{actionState.contactEmail}</p>
            </div>
          ) : null}
        </div>

        <div className="grid gap-6 p-5 text-slate-950 sm:p-6 lg:p-8">
          {cancelMode ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                {copy.selectedAppointment}
              </p>
              {actionState ? (
                <div className="mt-3 grid gap-2 text-sm text-slate-800">
                  <p className="text-lg font-semibold text-slate-950">{actionState.title}</p>
                  <p>
                    <span className="font-semibold">{copy.appointment}</span> {actionDateTime}
                  </p>
                  <p>
                    <span className="font-semibold">{copy.contact}</span> {actionState.contactName} -{" "}
                    {actionState.contactEmail}
                  </p>
                  <p>
                    <span className="font-semibold">{copy.location}</span> {meetingLabel}
                  </p>
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
                  {copy.status.invalidLink}
                </p>
              )}
            </div>
          ) : (
          <div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {copy.chooseTime}
                </p>
                <h2 className="mt-1 text-2xl font-semibold">{selectedMonth}</h2>
              </div>
              <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800">
                {copy.source} {source}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
              {(availability?.days ?? []).slice(0, 14).map((item) => (
                <a
                  aria-disabled={!item.available}
                  className={`rounded-lg border px-3 py-3 text-center text-sm font-semibold ${
                    item.selected
                      ? "border-slate-950 bg-slate-950 text-white"
                      : item.available
                        ? "border-slate-200 bg-white text-slate-950 hover:border-slate-400"
                        : "pointer-events-none border-slate-100 bg-slate-50 text-slate-300"
                  }`}
                  href={buildDateHref({
                    bookingId,
                    calendar,
                    date: item.date,
                    language,
                    meeting,
                    mode: rescheduleMode ? "reschedule" : "booking",
                    slug,
                    source,
                    theme,
                    token,
                    workspacePublicKey,
                    propertyContext,
                  })}
                  key={item.date}
                >
                  {item.label}
                </a>
              ))}
            </div>
          </div>
          )}

          {cancelMode ? (
            <form
              action={`/api/meetings/bookings/${encodeURIComponent(bookingId)}/cancel`}
              className="rounded-xl border border-red-200 bg-red-50 p-4"
              method="post"
            >
              <input name="slug" type="hidden" value={slug} />
              <input name="workspace_public_key" type="hidden" value={workspacePublicKey} />
              <input name="lang" type="hidden" value={language} />
              <input name="token" type="hidden" value={token} />
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">
                {copy.cancel}
              </p>
              <h2 className="mt-1 text-xl font-semibold text-red-950">
                {copy.cancelQuestion}
              </h2>
              {actionState ? (
                <div className="mt-4 rounded-lg border border-red-200 bg-white/70 p-3 text-sm text-red-950">
                  <p className="font-semibold">{actionState.title}</p>
                  <p className="mt-1">{actionDateTime}</p>
                  <p className="mt-1">{actionState.contactName}</p>
                </div>
              ) : null}
              <textarea
                className="mt-4 min-h-28 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-700"
                name="reason"
                placeholder={
                  savedAutomation.requireCancelReason
                    ? copy.cancelReasonRequired
                    : copy.cancelReasonOptional
                }
                required={Boolean(savedAutomation.requireCancelReason)}
              />
              <button
                className="mt-3 rounded-lg bg-red-700 px-4 py-3 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
                disabled={!actionState}
                type="submit"
              >
                {copy.cancel}
              </button>
            </form>
          ) : rescheduleMode ? (
            <form
              action={`/api/meetings/bookings/${encodeURIComponent(bookingId)}/reschedule`}
              className="grid gap-5 lg:grid-cols-[0.8fr_1fr]"
              method="post"
            >
              <input name="slug" type="hidden" value={slug} />
              <input name="workspace_public_key" type="hidden" value={workspacePublicKey} />
              <input name="lang" type="hidden" value={language} />
              <input name="token" type="hidden" value={token} />
              <input name="selectedDate" type="hidden" value={selectedDate} />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {copy.newTime}
                </p>
                <div className="mt-3 grid gap-2">
                  {(availability?.slots ?? []).map((slot) => (
                    <label className="block" key={slot.time}>
                      <input
                        className="peer sr-only"
                        defaultChecked={slot.time === defaultSlot}
                        disabled={!slot.available}
                        name="slot"
                        required={slot.available}
                        type="radio"
                        value={slot.time}
                      />
                      <span
                        className={`block rounded-lg border px-4 py-3 text-center text-sm font-semibold ${
                          slot.available
                            ? "border-slate-200 bg-white text-slate-950 hover:border-slate-950 peer-checked:border-slate-950 peer-checked:bg-slate-950 peer-checked:text-white"
                            : "border-slate-100 bg-slate-50 text-slate-300"
                        }`}
                      >
                        {slot.time}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {copy.reschedule}
                </p>
                <h2 className="mt-1 text-xl font-semibold">{actionPage?(language==="de"?"Neue Zeit anfragen":language==="es"?"Solicitar nueva hora":"Request new time"):copy.confirmNewTime}</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {actionPage?(language==="de"?"Die neue Zeit wird angefragt und vor der fachlichen Bestätigung erneut geprüft.":language==="es"?"Un asesor revisará la nueva hora antes de confirmar la visita.":"The new time is requested and reviewed before the viewing is confirmed again."):copy.rescheduleDescription}
                </p>
                <button
                  className="mt-4 w-full rounded-lg bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  disabled={!defaultSlot || !actionState}
                  type="submit"
                >
                  {copy.reschedule}
                </button>
              </div>
            </form>
          ) : actionPage ? (
            <p className="rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm">{language==='de'?'Ihre gespeicherte Terminanfrage ist oben dargestellt. Nutzen Sie die persönlichen Links zum Verschieben oder Absagen.':language==='es'?'Su solicitud guardada aparece arriba. Utilice sus enlaces personales para cambiarla o cancelarla.':'Your saved appointment request is shown above. Use your personal links to reschedule or cancel it.'}</p>
          ) : (
            <form action="/api/meetings/bookings" className="grid gap-5 lg:grid-cols-[0.8fr_1fr]" method="post">
              <input name="slug" type="hidden" value={slug} />
              <input name="workspace_public_key" type="hidden" value={workspacePublicKey} />
              <input name="lang" type="hidden" value={language} />
              <input name="calendar" type="hidden" value={calendar} />
              <input name="meeting" type="hidden" value={meeting} />
              <input name="selectedDate" type="hidden" value={selectedDate} />
              <input name="theme" type="hidden" value={theme} />
              <input name="utm_source" type="hidden" value={source} />
              {propertyContext&&<input name="property_context" type="hidden" value={propertyContext}/>}
              {submissionProof ? (
                <>
                  <input
                    name={publicSubmissionControlFields.idempotencyKey}
                    type="hidden"
                    value={submissionProof.idempotencyKey}
                  />
                  <input
                    name={publicSubmissionControlFields.issuedAt}
                    type="hidden"
                    value={submissionProof.issuedAt}
                  />
                  <input
                    name={publicSubmissionControlFields.expiresAt}
                    type="hidden"
                    value={submissionProof.expiresAt}
                  />
                  <input
                    name={publicSubmissionControlFields.proof}
                    type="hidden"
                    value={submissionProof.signature}
                  />
                  <label
                    aria-hidden="true"
                    className="absolute -left-[10000px] h-px w-px overflow-hidden"
                  >
                    Company
                    <input
                      autoComplete="off"
                      name={publicSubmissionControlFields.honeypot}
                      tabIndex={-1}
                      type="text"
                    />
                  </label>
                </>
              ) : null}
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {copy.availableTimes}
                </p>
                <div className="mt-3 grid gap-2">
                  {(availability?.slots ?? []).map((slot) => (
                    <label className="block" key={slot.time}>
                      <input
                        className="peer sr-only"
                        defaultChecked={slot.time === defaultSlot}
                        disabled={!slot.available}
                        name="slot"
                        required={slot.available}
                        type="radio"
                        value={slot.time}
                      />
                      <span
                        className={`block rounded-lg border px-4 py-3 text-center text-sm font-semibold ${
                          slot.available
                            ? "border-slate-200 bg-white text-slate-950 hover:border-slate-950 peer-checked:border-slate-950 peer-checked:bg-slate-950 peer-checked:text-white"
                            : "border-slate-100 bg-slate-50 text-slate-300"
                        }`}
                      >
                        {slot.time}
                      </span>
                    </label>
                  ))}
                </div>
                {!defaultSlot ? (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                    {copy.noTimes}
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {copy.yourInfo}
                </p>
                <div className="mt-4 grid gap-3">
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    {copy.name}
                    <input
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm normal-case tracking-normal outline-none focus:border-slate-950"
                      name="name"
                      placeholder={copy.namePlaceholder}
                      required
                      type="text"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    {copy.email}
                    <input
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm normal-case tracking-normal outline-none focus:border-slate-950"
                      name="email"
                      placeholder={copy.emailPlaceholder}
                      required
                      type="email"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    {copy.note}
                    <textarea
                      className="min-h-24 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm normal-case tracking-normal outline-none focus:border-slate-950"
                      name="note"
                      placeholder={copy.notePlaceholder}
                    />
                  </label>
                </div>
                <button
                  className="mt-4 w-full rounded-lg bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  disabled={!defaultSlot||(!!propertyContext&&!validPropertyOffer)}
                  type="submit"
                >
                  {propertyContext?(language==='de'?'Besichtigung anfragen':language==='es'?'Solicitar visita':'Request viewing'):copy.book}
                </button>
              </div>
            </form>
          )}

          {bookingError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold leading-5 text-red-900">
              {getStatusText(bookingError, copy)}
            </p>
          ) : submitted ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold leading-5 text-emerald-900">
              {propertyContext?(actionState?(language==='de'?'Ihre Terminanfrage ist eingegangen. Die Besichtigung wird nach persönlicher Prüfung bestätigt.':language==='es'?'Hemos recibido su solicitud. La visita se confirmará tras la revisión personal.':'Your appointment request has been received. The viewing will be confirmed after personal review.'):(language==='de'?'Der Eingang konnte noch nicht bestätigt werden. Bitte den ursprünglichen Vorgang erneut prüfen.':language==='es'?'Aún no se ha confirmado la recepción. Compruebe la solicitud original.':'Receipt has not yet been confirmed. Please check the original request again.')):confirmed
                ? copy.status.confirmed(sentMessages)
                : copy.status.booked(queuedMessages, sentMessages)}
            </p>
          ) : cancelled ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold leading-5 text-emerald-900">
              {copy.status.cancelled}
            </p>
          ) : rescheduled ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold leading-5 text-emerald-900">
              {actionPage?(language==='de'?'Die neue Zeit wurde angefragt. Ihre Besichtigung wird nach erneuter persönlicher Prüfung bestätigt.':language==='es'?'Se ha solicitado la nueva hora. Un asesor revisará y confirmará la visita.':'The new time has been requested. Your adviser will review and confirm the viewing again.'):copy.status.rescheduled}
            </p>
          ) : null}
          {(propertyContext||actionPage)&&actionState&&actionState.status!=='cancelled'&&<div className="flex flex-wrap gap-3">{savedAutomation.allowReschedule!==false&&<a className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 px-4 text-sm" rel="noreferrer" href={propertyActionHref('reschedule')}>{copy.reschedule}</a>}{savedAutomation.allowCancel!==false&&<a className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 px-4 text-sm" rel="noreferrer" href={propertyActionHref('cancel')}>{copy.cancel}</a>}</div>}

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              {copy.afterBooking}
            </p>
            {propertyContext||actionPage?<p className="mt-3 text-sm text-slate-700">{language==='de'?'Ihr Ansprechpartner prüft Teilnehmer und Termin. Bewahren Sie Ihren persönlichen Verwaltungslink auf. Eine automatische E-Mail oder Kalendereinladung wird hier nicht zugesagt.':language==='es'?'Su asesor revisará el participante y la cita. Guarde su enlace personal de gestión. Aquí no se promete un correo ni una invitación automática.':'Your adviser will review the participant and appointment. Keep your personal management link. An automatic email or calendar invitation is not promised here.'}</p>:<div className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
              <span className="rounded-lg bg-slate-50 px-3 py-2">
                {savedAutomation.confirmationEnabled === false
                  ? copy.noConfirmation
                  : savedAutomation.confirmationTitle || copy.confirmationMail}
              </span>
              <span className="rounded-lg bg-slate-50 px-3 py-2">
                {activeReminderCount ? copy.reminderActive(String(activeReminderCount)) : copy.reminderOptional}
              </span>
              <span className="rounded-lg bg-slate-50 px-3 py-2">
                {savedAutomation.allowReschedule || savedAutomation.allowCancel
                  ? `${savedAutomation.allowReschedule ? copy.reschedule : ""}${
                      savedAutomation.allowReschedule && savedAutomation.allowCancel ? " + " : ""
                    }${savedAutomation.allowCancel ? copy.cancel : ""}`
                  : copy.selfServiceOff}
              </span>
            </div>}
          </div>
        </div>
      </section>
    </main>
  );
}
