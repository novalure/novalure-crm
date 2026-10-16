import { getMicrosoftCalendarAppToken } from "@/lib/integrations/microsoft-calendar";
import { escapeHtmlText } from "@/lib/security/public-submission-abuse";

export type StudioCalendarPolicy = {
  approvalId: string;
  organizerId: string;
  calendarId: string;
  timeZone: string;
  durationMinutes: number;
  intervalMinutes: number;
  minNoticeMinutes: number;
  bufferMinutes: number;
  horizonDays: number;
  hours: Record<string, Array<{ start: number; end: number }>>;
};
export type StudioCalendarEvent = {
  confirmed: true;
  eventId: string;
  teamsUrl: string | null;
  invitationTriggered: true;
};

function validZone(value: string) {
  try { return Boolean(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); }
  catch { return false; }
}

export function readStudioCalendarPolicy(env: NodeJS.ProcessEnv = process.env): StudioCalendarPolicy | null {
  const isolatedLocalTest = env.NODE_ENV === "test" && env.CRM_LOCAL_TEST_DATABASE === "1";
  if (!isolatedLocalTest && env.VERCEL_ENV !== "preview") return null;
  if (env.STUDIO_BOOKING_REAL_MODE !== "1" || !env.STUDIO_BOOKING_POLICY_JSON ||
      !env.STUDIO_BOOKING_CONFIG_APPROVAL_ID) return null;
  let value: Partial<StudioCalendarPolicy>;
  try { value = JSON.parse(env.STUDIO_BOOKING_POLICY_JSON) as Partial<StudioCalendarPolicy>; }
  catch { return null; }
  if (!value || typeof value !== "object" ||
      value.approvalId !== env.STUDIO_BOOKING_CONFIG_APPROVAL_ID ||
      !/^[A-Za-z0-9._:-]{8,120}$/.test(value.approvalId) ||
      !value.organizerId || value.organizerId !== env.MICROSOFT_CALENDAR_USER_ID ||
      !value.calendarId || value.calendarId.length > 256 ||
      !value.timeZone || !validZone(value.timeZone) ||
      !Number.isInteger(value.durationMinutes) || value.durationMinutes! < 10 || value.durationMinutes! > 180 ||
      !Number.isInteger(value.intervalMinutes) || value.intervalMinutes! < 5 || value.intervalMinutes! > 180 ||
      !Number.isInteger(value.minNoticeMinutes) || value.minNoticeMinutes! < 0 ||
      !Number.isInteger(value.bufferMinutes) || value.bufferMinutes! < 0 ||
      !Number.isInteger(value.horizonDays) || value.horizonDays! < 1 || value.horizonDays! > 60 ||
      !value.hours || typeof value.hours !== "object") return null;
  for (const [day, windows] of Object.entries(value.hours)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(windows) || windows.some((window) =>
      !Number.isInteger(window.start) || !Number.isInteger(window.end) ||
      window.start < 0 || window.end > 1440 || window.end <= window.start)) return null;
  }
  return value as StudioCalendarPolicy;
}

function calendarRoot(policy: StudioCalendarPolicy) {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(policy.organizerId)}` +
    `/calendars/${encodeURIComponent(policy.calendarId)}`;
}

async function calendarToken(policy: StudioCalendarPolicy) {
  const token = await getMicrosoftCalendarAppToken(policy.organizerId);
  if (!token) throw new Error("calendar_auth_unavailable");
  return token;
}

function eventInstant(value: unknown) {
  if (typeof value !== "string") throw new Error("calendar_response_invalid");
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(parsed)) throw new Error("calendar_response_invalid");
  return new Date(parsed).toISOString();
}

async function calendarView(policy: StudioCalendarPolicy, start: string, end: string) {
  const token = await calendarToken(policy);
  const root = `${calendarRoot(policy)}/calendarView`;
  const initial = new URL(root);
  initial.searchParams.set("startDateTime", start);
  initial.searchParams.set("endDateTime", end);
  initial.searchParams.set("$select", "id,start,end,showAs,transactionId,onlineMeeting");
  initial.searchParams.set("$top", "100");
  let next: string | null = initial.toString();
  const events: Array<{ id?: string; start?: { dateTime?: string }; end?: { dateTime?: string };
    showAs?: string; transactionId?: string; onlineMeeting?: { joinUrl?: string } }> = [];
  for (let page = 0; next && page < 20; page += 1) {
    const url = new URL(next);
    if (url.origin !== "https://graph.microsoft.com" || url.pathname !== new URL(root).pathname) {
      throw new Error("calendar_response_invalid");
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "calendar_permission_denied" : "calendar_availability_unavailable");
    const data = await response.json() as { value?: typeof events; "@odata.nextLink"?: string };
    if (!Array.isArray(data.value)) throw new Error("calendar_response_invalid");
    events.push(...data.value);
    next = data["@odata.nextLink"] ?? null;
  }
  if (next) throw new Error("calendar_response_truncated");
  return events;
}

export async function listStudioMicrosoftBusy(policy: StudioCalendarPolicy, start: string, end: string) {
  const events = await calendarView(policy, start, end);
  return events.filter((event) => event.showAs !== "free").map((event) => ({
    start: eventInstant(event.start?.dateTime), end: eventInstant(event.end?.dateTime),
  }));
}

function teamsLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "teams.microsoft.com" || url.hostname.endsWith(".teams.microsoft.com"))
      ? value : null;
  } catch { return null; }
}

export async function findStudioMicrosoftEvent(policy: StudioCalendarPolicy, input: {
  start: string; end: string; transactionId: string;
}): Promise<StudioCalendarEvent | null> {
  const events = await calendarView(policy, input.start, input.end);
  const event = events.find((item) => item.transactionId === input.transactionId);
  if (!event?.id) return null;
  return { confirmed: true, eventId: event.id, teamsUrl: teamsLink(event.onlineMeeting?.joinUrl),
    invitationTriggered: true };
}

export async function createStudioMicrosoftEvent(policy: StudioCalendarPolicy, input: {
  transactionId: string; kind: "phone" | "teams"; start: string; end: string;
  name: string; email: string; phone: string; reason: string; visitorTimeZone: string;
}): Promise<StudioCalendarEvent> {
  const token = await calendarToken(policy);
  const visitorTime = new Intl.DateTimeFormat("en-IE", { timeZone: input.visitorTimeZone,
    weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit",
    minute: "2-digit", timeZoneName: "short" }).format(new Date(input.start));
  const bodyText = [
    `Novalure Studio ${input.kind === "teams" ? "Teams video" : "phone"} appointment.`,
    `Time: ${escapeHtmlText(visitorTime)} (${escapeHtmlText(input.visitorTimeZone)}).`,
    input.kind === "phone" ? `Franz calls ${escapeHtmlText(input.phone)}.` : "Join using the Teams link in this invitation.",
    `Reason: ${escapeHtmlText(input.reason.slice(0, 300))}`,
  ].map((line) => `<p>${line}</p>`).join("");
  const response = await fetch(`${calendarRoot(policy)}/events`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' },
    body: JSON.stringify({
      subject: `Novalure Studio ${input.kind === "teams" ? "video" : "phone"} consultation`,
      body: { contentType: "HTML", content: bodyText },
      start: { dateTime: input.start.replace(/Z$/, ""), timeZone: "UTC" },
      end: { dateTime: input.end.replace(/Z$/, ""), timeZone: "UTC" },
      attendees: [{ emailAddress: { address: input.email, name: input.name }, type: "required" }],
      transactionId: input.transactionId,
      isOnlineMeeting: input.kind === "teams",
      onlineMeetingProvider: input.kind === "teams" ? "teamsForBusiness" : undefined,
    }),
  });
  if (response.status !== 201) throw new Error(response.status === 401 || response.status === 403
    ? "calendar_permission_denied" : "calendar_create_uncertain");
  const event = await response.json() as { id?: string; onlineMeeting?: { joinUrl?: string } };
  if (!event.id) throw new Error("calendar_create_uncertain");
  return { confirmed: true, eventId: event.id, teamsUrl: teamsLink(event.onlineMeeting?.joinUrl),
    invitationTriggered: true };
}
