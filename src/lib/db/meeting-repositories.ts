import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { getProductRoleCapabilities } from "@/lib/product-model";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { insertCalendarSyncEvent, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { queueMeetingBookedGoogleNotification } from "@/lib/db/google-notification-repositories";
import { queueMeetingBookedTeamsNotification } from "@/lib/db/teams-notification-repositories";
import {
  deleteMicrosoftCalendarEvent,
  listMicrosoftBusyTimes,
  syncMicrosoftCalendarEvent,
  updateMicrosoftCalendarEvent,
} from "@/lib/integrations/microsoft-calendar";
import {
  deleteGoogleCalendarEvent,
  listGoogleBusyTimes,
  syncGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "@/lib/integrations/google-calendar";

export type MeetingPageSettings = {
  automation: unknown;
  calendarIntegrations: unknown;
  id?: string;
  meetingType?: "group" | "personal" | "round_robin";
  ownerUserId?: string | null;
  projectId?: string | null;
  shareConfig: unknown;
  slug: string;
  title: string;
  updatedAt?: string | Date | null;
  workspaceId?: string | null;
};

type MeetingPageRow = {
  id: string;
  meetingType: "group" | "personal" | "round_robin";
  ownerUserId: string | null;
  projectId: string | null;
  slug: string;
  title: string;
  calendarIntegrations: unknown;
  shareConfig: unknown;
  automation: unknown;
  updatedAt: string | Date | null;
  workspaceId: string | null;
};

export type MeetingPagesPayload = {
  error?: string;
  pages: MeetingPageSettings[];
  source: "database" | "fallback";
};

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toMeetingPageSettings(row: MeetingPageRow): MeetingPageSettings {
  return {
    automation: row.automation,
    calendarIntegrations: row.calendarIntegrations,
    id: row.id,
    meetingType: row.meetingType,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    shareConfig: row.shareConfig,
    slug: row.slug,
    title: row.title,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId,
  };
}

export async function listMeetingPageSettings(input: {
  limit?: number;
  session: AppSession;
}): Promise<MeetingPagesPayload> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { pages: [], source: "fallback" };
  }

  try {
    const rows = await queryRows<MeetingPageRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          meeting_type as "meetingType",
          slug,
          title,
          calendar_integrations as "calendarIntegrations",
          share_config as "shareConfig",
          automation,
          updated_at as "updatedAt"
        from meeting_pages
        where workspace_id = $1
        order by updated_at desc
        limit $2
      `,
      [input.session.workspaceId, input.limit ?? 25],
    );

    return {
      pages: rows.map(toMeetingPageSettings),
      source: "database",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Meeting settings loader failed",
      pages: [],
      source: "fallback",
    };
  }
}

export async function getMeetingPageSettings(input: {
  session: AppSession;
  slug: string;
}): Promise<MeetingPageSettings | null> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) return null;

  const slug = normalizeSlug(input.slug);
  if (!slug) return null;

  try {
    const row = await queryOne<MeetingPageRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          meeting_type as "meetingType",
          slug,
          title,
          calendar_integrations as "calendarIntegrations",
          share_config as "shareConfig",
          automation,
          updated_at as "updatedAt"
        from meeting_pages
        where workspace_id = $1 and slug = $2
        limit 1
      `,
      [input.session.workspaceId, slug],
    );

    return row ? toMeetingPageSettings(row) : null;
  } catch {
    return null;
  }
}

export async function getPublicMeetingPageSettings(slugValue: string): Promise<MeetingPageSettings | null> {
  if (!hasDatabaseUrl()) return null;

  const slug = normalizeSlug(slugValue);
  if (!slug) return null;

  try {
    const row = await queryOne<MeetingPageRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          meeting_type as "meetingType",
          slug,
          title,
          calendar_integrations as "calendarIntegrations",
          share_config as "shareConfig",
          automation,
          updated_at as "updatedAt"
        from meeting_pages
        where slug = $1 and status = 'active'
        order by updated_at desc
        limit 1
      `,
      [slug],
    );

    return row ? toMeetingPageSettings(row) : null;
  } catch {
    return null;
  }
}

export async function upsertMeetingPageSettings(input: {
  page: MeetingPageSettings;
  session: AppSession;
}): Promise<{ page: MeetingPageSettings | null; persisted: boolean; reason?: string }> {
  if (!hasDatabaseUrl()) {
    return { page: null, persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (!isUuid(input.session.workspaceId)) {
    return { page: null, persisted: false, reason: "Workspace is not a database UUID" };
  }

  const slug = normalizeSlug(input.page.slug);
  if (!slug) {
    return { page: null, persisted: false, reason: "Meeting slug is required" };
  }

  try {
    const row = await queryOne<MeetingPageRow>(
      `
        insert into meeting_pages (
          workspace_id,
          owner_user_id,
          meeting_type,
          slug,
          title,
          calendar_integrations,
          share_config,
          automation,
          status
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, 'active')
        on conflict (workspace_id, slug)
        do update set
          owner_user_id = excluded.owner_user_id,
          meeting_type = excluded.meeting_type,
          title = excluded.title,
          calendar_integrations = excluded.calendar_integrations,
          share_config = excluded.share_config,
          automation = excluded.automation,
          status = 'active',
          updated_at = now()
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          meeting_type as "meetingType",
          slug,
          title,
          calendar_integrations as "calendarIntegrations",
          share_config as "shareConfig",
          automation,
          updated_at as "updatedAt"
      `,
      [
        input.session.workspaceId,
        isUuid(input.session.userId) ? input.session.userId : null,
        input.page.meetingType || "personal",
        slug,
        input.page.title || "Meeting",
        JSON.stringify(input.page.calendarIntegrations ?? {}),
        JSON.stringify(input.page.shareConfig ?? {}),
        JSON.stringify(input.page.automation ?? {}),
      ],
    );

    if (!row) {
      return { page: null, persisted: false, reason: "Meeting settings could not be saved" };
    }

    await writeAuditLog({
      session: input.session,
      action: "meeting_page.settings_saved",
      entityId: row.id,
      entityType: "meeting_page",
      after: { slug: row.slug, title: row.title },
    });

    return { page: toMeetingPageSettings(row), persisted: true };
  } catch (error) {
    return {
      page: null,
      persisted: false,
      reason: error instanceof Error ? error.message : "Meeting settings could not be saved",
    };
  }
}

type ReminderUnit = "minutes" | "hours" | "days" | "weeks";

type MeetingReminderConfig = {
  amount?: string;
  body?: string;
  channel?: string;
  enabled?: boolean;
  id?: string;
  subject?: string;
  title?: string;
  unit?: ReminderUnit;
};

type MeetingAutomationConfig = {
  allowCancel?: boolean;
  allowReschedule?: boolean;
  cancelDeadlineHours?: string;
  confirmationBody?: string;
  confirmationEnabled?: boolean;
  confirmationSubject?: string;
  confirmationTitle?: string;
  postFollowUpDelayHours?: string;
  postFollowUpEnabled?: boolean;
  reminderEnabled?: boolean;
  reminders?: MeetingReminderConfig[];
  requireCancelReason?: boolean;
  rescheduleDeadlineHours?: string;
};

type CreateMeetingBookingResult = {
  autoConfirmed?: boolean;
  bookingId?: string | null;
  confirmationStatus?: string | null;
  finalConfirmationJobId?: string | null;
  jobsQueued?: number;
  onlineMeetingUrl?: string | null;
  persisted: boolean;
  reason?: string;
};

type MeetingAvailabilityRules = {
  bufferMinutes: number;
  durationMinutes: number;
  intervalMinutes: number;
  minNoticeMinutes: number;
  rollingWeeks: number;
  timeZone: string;
  weeklyHours: Array<{ day: number; end: string; start: string }>;
};

type IdRow = {
  id: string;
};

type CountRow = {
  count: number | string;
};

export type MeetingBookingInput = {
  calendarProvider: string;
  contactEmail: string;
  contactName: string;
  contactNote?: string;
  meetingProvider: string;
  requestUrl: string;
  selectedDate: string;
  slot: string;
  slug: string;
  source?: string;
};

export type MeetingNotificationJob = {
  body: string;
  bookingId: string;
  id: string;
  kind: "confirmation" | "reminder" | "follow_up";
  provider: string | null;
  recipientEmail: string;
  scheduledFor: string | Date;
  subject: string;
  title: string;
  tokens: Record<string, string>;
};

export type MeetingBookingOverviewBooking = {
  calendarProvider: string;
  contactEmail: string;
  contactName: string;
  contactNote: string;
  createdAt: string | Date;
  endsAt: string | Date;
  id: string;
  meetingProvider: string;
  pageSlug: string | null;
  slug: string;
  source: string;
  startsAt: string | Date;
  status: string;
  title: string;
};

export type MeetingBookingOverviewNotification = {
  attempts: number;
  bookingId: string | null;
  bookingTitle: string | null;
  contactName: string | null;
  error: string | null;
  id: string;
  kind: "confirmation" | "reminder" | "follow_up";
  provider: string | null;
  recipientEmail: string;
  scheduledFor: string | Date;
  sentAt: string | Date | null;
  status: string;
  subject: string;
  tokens: Record<string, string> | null;
};

export type MeetingBookingOverview = {
  bookings: MeetingBookingOverviewBooking[];
  metrics: {
    failedNotifications: number;
    queuedNotifications: number;
    requestedBookings: number;
    sentNotifications: number;
    totalBookings: number;
  };
  notifications: MeetingBookingOverviewNotification[];
  source: "database" | "fallback";
};

export type PublicMeetingAvailability = {
  date: string;
  days: Array<{
    available: boolean;
    date: string;
    label: string;
    selected: boolean;
  }>;
  rules: {
    bufferMinutes: number;
    durationMinutes: number;
    intervalMinutes: number;
    minNoticeMinutes: number;
    rollingWeeks: number;
    timeZone: string;
  };
  slots: Array<{
    available: boolean;
    reason?: string;
    time: string;
  }>;
};

export type PublicMeetingBookingActionState = {
  contactEmail: string;
  contactName: string;
  endsAt: string | Date;
  id: string;
  pageSlug: string | null;
  startsAt: string | Date;
  status: string;
  title: string;
};

type MeetingBookingOverviewMetricRow = {
  failedNotifications: number | string;
  queuedNotifications: number | string;
  requestedBookings: number | string;
  sentNotifications: number | string;
  totalBookings: number | string;
};

type MeetingBookingConfirmationRow = {
  automation: unknown;
  calendarProvider: string;
  contactEmail: string;
  contactId: string | null;
  contactName: string;
  contactNote: string;
  endsAt: string | Date;
  id: string;
  meetingPageId: string | null;
  meetingProvider: string;
  metadata: Record<string, unknown> | null;
  ownerUserId: string | null;
  pageSlug: string | null;
  pageTitle: string | null;
  projectId: string | null;
  slug: string;
  startsAt: string | Date;
  status: string;
  title: string;
  workspaceId: string;
};

type MeetingNotificationJobRow = {
  body: string;
  bookingId: string;
  id: string;
  kind: "confirmation" | "reminder" | "follow_up";
  provider: string | null;
  recipientEmail: string;
  scheduledFor: string | Date;
  subject: string;
  title: string;
  tokens: Record<string, string> | null;
};

type PublicMeetingBookingRow = {
  automation: unknown;
  calendarIntegrations: unknown;
  calendarProvider: string;
  contactEmail: string;
  contactName: string;
  contactNote: string;
  endsAt: string | Date;
  id: string;
  meetingPageId: string | null;
  meetingProvider: string;
  metadata: Record<string, unknown> | null;
  pageSlug: string | null;
  pageTitle: string | null;
  slug: string;
  startsAt: string | Date;
  status: string;
  title: string;
  workspaceId: string;
};

function asAutomation(value: unknown): MeetingAutomationConfig {
  if (!value || typeof value !== "object") return {};
  return value as MeetingAutomationConfig;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function asTokens(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, tokenValue]) => [
      key,
      typeof tokenValue === "string" ? tokenValue : String(tokenValue ?? ""),
    ]),
  );
}

function safeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function firstName(value: string) {
  return value.trim().split(/\s+/)[0] || "dort";
}

function addMinutes(value: Date, minutes: number) {
  return new Date(value.getTime() + minutes * 60_000);
}

function getNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getDateKey(value: Date, timeZone = "Europe/Vienna") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(value);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function zonedTimeToUtc(dateKey: string, time: string, timeZone = "Europe/Vienna") {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(utcGuess);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );

  return new Date(utcGuess.getTime() - (zonedAsUtc - utcGuess.getTime()));
}

function getWeekday(dateKey: string) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

function getAvailabilityRules(page: MeetingPageSettings): MeetingAvailabilityRules {
  const calendarConfig = asRecord(page.calendarIntegrations);
  const availabilityConfig = asRecord(calendarConfig.availability);
  const rawWeeklyHours = Array.isArray(availabilityConfig.weeklyHours)
    ? availabilityConfig.weeklyHours
    : null;
  const weeklyHours =
    rawWeeklyHours
      ?.map((entry) => {
        const value = asRecord(entry);
        return {
          day: getNumber(value.day, 1, 0, 6),
          end: typeof value.end === "string" ? value.end : "17:00",
          start: typeof value.start === "string" ? value.start : "09:00",
        };
      })
      .filter((entry) => /^\d{2}:\d{2}$/.test(entry.start) && /^\d{2}:\d{2}$/.test(entry.end)) ?? [
      { day: 1, end: "17:00", start: "09:00" },
      { day: 2, end: "17:00", start: "09:00" },
      { day: 3, end: "17:00", start: "09:00" },
      { day: 4, end: "17:00", start: "09:00" },
      { day: 5, end: "17:00", start: "09:00" },
    ];

  return {
    bufferMinutes: getNumber(availabilityConfig.bufferMinutes, 15, 0, 240),
    durationMinutes: getNumber(availabilityConfig.durationMinutes, 30, 5, 480),
    intervalMinutes: getNumber(availabilityConfig.intervalMinutes, 30, 5, 240),
    minNoticeMinutes: getNumber(availabilityConfig.minNoticeMinutes, 15, 0, 10080),
    rollingWeeks: getNumber(availabilityConfig.rollingWeeks, 2, 1, 52),
    timeZone: typeof availabilityConfig.timeZone === "string" ? availabilityConfig.timeZone : "Europe/Vienna",
    weeklyHours,
  };
}

function getReminderOffsetMinutes(reminder: MeetingReminderConfig) {
  const amount = Number.parseInt(reminder.amount || "0", 10);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (reminder.unit === "weeks") return amount * 7 * 24 * 60;
  if (reminder.unit === "days") return amount * 24 * 60;
  if (reminder.unit === "minutes") return amount;
  return amount * 60;
}

function parseBookingStart(selectedDate: string, slot: string, timeZone = "Europe/Vienna") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return null;
  if (!/^\d{2}:\d{2}$/.test(slot)) return null;

  const start = zonedTimeToUtc(selectedDate, slot, timeZone);
  return Number.isNaN(start.getTime()) ? null : start;
}

function formatMeetingDate(value: Date) {
  return new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
}

function formatMeetingTime(value: string | Date) {
  return new Intl.DateTimeFormat("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Vienna",
  }).format(new Date(normalizeDateInput(value)));
}

const publicAppOrigin = "https://www.novalure-crm.app";

function getRequestOrigin(value?: string | null) {
  if (process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    return process.env.NEXT_PUBLIC_APP_URL.trim().replace(/\/$/, "");
  }

  try {
    if (value) {
      const requestOrigin = new URL(value).origin;
      if (
        requestOrigin.includes("localhost") ||
        requestOrigin.includes("127.0.0.1") ||
        requestOrigin.includes("[::1]")
      ) {
        return requestOrigin;
      }
    }
  } catch {
    // Fall back to the public production URL below.
  }

  return publicAppOrigin;
}

function getMeetingLocation(meetingProvider: string) {
  if (meetingProvider === "google-meet") return "Google Meet";
  if (meetingProvider === "phone") return "Telefon";
  if (meetingProvider === "manual-link") return "Meetinglink";
  return "Microsoft Teams";
}

function expectsOnlineMeetingLink(meetingProvider: string) {
  return meetingProvider === "microsoft-teams" || meetingProvider === "google-meet";
}

function createPublicBookingSession(input: {
  ownerUserId?: string | null;
  workspaceId: string;
}): AppSession {
  return {
    authenticated: true,
    email: "booking-page@novalure.local",
    name: "Public Booking",
    permissions: ["crm:read", "crm:write", "calendar:sync"],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "owner",
    source: "database",
    userId: input.ownerUserId && isUuid(input.ownerUserId) ? input.ownerUserId : "",
    workspaceId: input.workspaceId,
    workspaceName: "Novalure",
  };
}

function getTokenValues(input: {
  bookingId: string;
  contactEmail: string;
  contactName: string;
  meetingProvider: string;
  origin: string;
  page: MeetingPageSettings;
  publicToken?: string;
  selectedDate: Date;
  slot: string;
}) {
  const bookingUrl = `${input.origin}/book/${input.page.slug}`;
  const actionQuery = `booking=${encodeURIComponent(input.bookingId)}&token=${encodeURIComponent(
    input.publicToken || "",
  )}`;
  const meetingLink = `${bookingUrl}?${actionQuery}&join=1`;

  return {
    "{{contact.email}}": input.contactEmail,
    "{{contact.firstName}}": firstName(input.contactName),
    "{{host.name}}": "Novalure",
    "{{meeting.cancelLink}}": `${bookingUrl}?${actionQuery}&cancel=1`,
    "{{meeting.date}}": formatMeetingDate(input.selectedDate),
    "{{meeting.link}}": meetingLink,
    "{{meeting.location}}": getMeetingLocation(input.meetingProvider),
    "{{meeting.rescheduleLink}}": `${bookingUrl}?${actionQuery}&reschedule=1`,
    "{{meeting.time}}": input.slot,
    "{{meeting.title}}": input.page.title,
  };
}

function resolveTokens(value: string, tokens: Record<string, string>) {
  return Object.entries(tokens).reduce(
    (current, [token, tokenValue]) => current.replaceAll(token, tokenValue),
    value,
  );
}

function ensureMeetingLinkInBody(value: string) {
  if (value.includes("{{meeting.link}}")) return value;
  return `${value.trim()}\n\nMeeting-Link: {{meeting.link}}`;
}

function ensureMeetingActionLinksInBody(value: string, automation: MeetingAutomationConfig) {
  const additions: string[] = [];

  if (automation.allowReschedule !== false && !value.includes("{{meeting.rescheduleLink}}")) {
    additions.push("Termin verschieben: {{meeting.rescheduleLink}}");
  }

  if (automation.allowCancel !== false && !value.includes("{{meeting.cancelLink}}")) {
    additions.push("Termin absagen: {{meeting.cancelLink}}");
  }

  return additions.length > 0 ? `${value.trim()}\n\n${additions.join("\n")}` : value;
}

function getFinalConfirmationTokens(input: {
  booking: MeetingBookingConfirmationRow;
  onlineMeetingUrl: string;
  origin: string;
}) {
  const bookingSlug = input.booking.pageSlug || input.booking.slug;
  const bookingUrl = `${input.origin}/book/${bookingSlug}`;
  const metadata = getBookingMetadata(input.booking.metadata);
  const actionQuery = `booking=${encodeURIComponent(input.booking.id)}&token=${encodeURIComponent(
    typeof metadata.publicToken === "string" ? metadata.publicToken : "",
  )}`;

  return {
    "{{contact.email}}": input.booking.contactEmail,
    "{{contact.firstName}}": firstName(input.booking.contactName),
    "{{host.name}}": "Novalure",
    "{{meeting.cancelLink}}": `${bookingUrl}?${actionQuery}&cancel=1`,
    "{{meeting.date}}": formatMeetingDate(new Date(normalizeDateInput(input.booking.startsAt))),
    "{{meeting.link}}": input.onlineMeetingUrl,
    "{{meeting.location}}": getMeetingLocation(input.booking.meetingProvider),
    "{{meeting.rescheduleLink}}": `${bookingUrl}?${actionQuery}&reschedule=1`,
    "{{meeting.time}}": formatMeetingTime(input.booking.startsAt),
    "{{meeting.title}}": input.booking.pageTitle || input.booking.title,
  };
}

async function queueMeetingNotificationJob(input: {
  body: string;
  bookingId: string;
  kind: "confirmation" | "reminder" | "follow_up";
  meetingPageId: string;
  recipientEmail: string;
  scheduledFor: Date;
  subject: string;
  title: string;
  tokens: Record<string, string>;
  workspaceId: string;
}) {
  const row = await queryOne<IdRow>(
    `
      insert into meeting_notification_jobs (
        workspace_id,
        meeting_page_id,
        booking_id,
        kind,
        scheduled_for,
        recipient_email,
        subject,
        title,
        body,
        tokens
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      returning id
    `,
    [
      input.workspaceId,
      input.meetingPageId,
      input.bookingId,
      input.kind,
      input.scheduledFor.toISOString(),
      input.recipientEmail,
      input.subject,
      input.title,
      input.body,
      JSON.stringify(input.tokens),
    ],
  );

  return row?.id ?? null;
}

function minutesFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(value: number) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

async function listDatabaseBusyTimes(input: {
  meetingPageId: string;
  timeMax: string;
  timeMin: string;
}) {
  return queryRows<{ endsAt: string | Date; startsAt: string | Date }>(
    `
      select starts_at as "startsAt", ends_at as "endsAt"
      from meeting_bookings
      where meeting_page_id = $1
        and status in ('requested', 'confirmed', 'rescheduled')
        and starts_at < $3::timestamptz
        and ends_at > $2::timestamptz
    `,
    [input.meetingPageId, input.timeMin, input.timeMax],
  );
}

async function listExternalBusyTimes(input: {
  calendarProvider: string;
  timeMax: string;
  timeMin: string;
  timeZone: string;
  workspaceId: string;
}) {
  if (input.calendarProvider === "google") {
    return listGoogleBusyTimes({
      timeMax: input.timeMax,
      timeMin: input.timeMin,
      timeZone: input.timeZone,
      workspaceId: input.workspaceId,
    }).catch(() => []);
  }

  if (input.calendarProvider !== "microsoft") {
    return [];
  }

  return listMicrosoftBusyTimes({
    timeMax: input.timeMax,
    timeMin: input.timeMin,
    workspaceId: input.workspaceId,
  }).catch(() => []);
}

function getCalendarProviderFromPage(page: MeetingPageSettings) {
  const config = asRecord(page.calendarIntegrations);
  const provider = config.defaultProvider;
  if (provider === "google" || provider === "microsoft") return provider;
  return "none";
}

export async function getPublicMeetingAvailability(input: {
  date?: string;
  slug: string;
}): Promise<PublicMeetingAvailability | null> {
  const page = await getPublicMeetingPageSettings(input.slug);
  if (!page?.id || !page.workspaceId) return null;

  const rules = getAvailabilityRules(page);
  const todayKey = getDateKey(new Date(), rules.timeZone);
  const firstDay = new Date(`${todayKey}T12:00:00Z`);
  const dayCount = rules.rollingWeeks * 7;
  const candidateDays = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * 24 * 60 * 60_000);
    const dateKey = date.toISOString().slice(0, 10);
    const weekday = getWeekday(dateKey);
    const hasWindow = rules.weeklyHours.some((window) => window.day === weekday);

    return {
      available: hasWindow,
      date: dateKey,
      label: new Intl.DateTimeFormat("de-AT", {
        day: "2-digit",
        month: "2-digit",
        weekday: "short",
      }).format(date),
      selected: false,
    };
  });
  const selectedDate =
    candidateDays.find((day) => day.date === input.date)?.date ||
    candidateDays.find((day) => day.available)?.date ||
    candidateDays[0]?.date ||
    todayKey;
  const windows = rules.weeklyHours.filter((window) => window.day === getWeekday(selectedDate));
  const dayStart = zonedTimeToUtc(selectedDate, "00:00", rules.timeZone);
  const dayEnd = addMinutes(dayStart, 24 * 60);
  const calendarProvider = getCalendarProviderFromPage(page);
  const [databaseBusy, externalBusy] = await Promise.all([
    listDatabaseBusyTimes({
      meetingPageId: page.id,
      timeMax: dayEnd.toISOString(),
      timeMin: dayStart.toISOString(),
    }),
    listExternalBusyTimes({
      calendarProvider,
      timeMax: dayEnd.toISOString(),
      timeMin: dayStart.toISOString(),
      timeZone: rules.timeZone,
      workspaceId: page.workspaceId,
    }),
  ]);
  const busyRanges = [
    ...databaseBusy.map((busy) => ({
      end: new Date(normalizeDateInput(busy.endsAt)),
      start: new Date(normalizeDateInput(busy.startsAt)),
    })),
    ...externalBusy.map((busy) => ({
      end: new Date(busy.end),
      start: new Date(busy.start),
    })),
  ].filter((busy) => !Number.isNaN(busy.start.getTime()) && !Number.isNaN(busy.end.getTime()));
  const minStart = addMinutes(new Date(), rules.minNoticeMinutes);
  const slots = windows.flatMap((window) => {
    const startMinutes = minutesFromTime(window.start);
    const endMinutes = minutesFromTime(window.end);
    const result: PublicMeetingAvailability["slots"] = [];

    for (
      let minutes = startMinutes;
      minutes + rules.durationMinutes <= endMinutes;
      minutes += rules.intervalMinutes
    ) {
      const time = timeFromMinutes(minutes);
      const slotStart = zonedTimeToUtc(selectedDate, time, rules.timeZone);
      const slotEnd = addMinutes(slotStart, rules.durationMinutes);
      const tooSoon = slotStart.getTime() < minStart.getTime();
      const busy = busyRanges.some((busyRange) =>
        overlaps(
          slotStart,
          slotEnd,
          addMinutes(busyRange.start, -rules.bufferMinutes),
          addMinutes(busyRange.end, rules.bufferMinutes),
        ),
      );

      result.push({
        available: !tooSoon && !busy,
        reason: tooSoon ? "too_soon" : busy ? "busy" : undefined,
        time,
      });
    }

    return result;
  });

  return {
    date: selectedDate,
    days: candidateDays.map((day) => ({ ...day, selected: day.date === selectedDate })),
    rules: {
      bufferMinutes: rules.bufferMinutes,
      durationMinutes: rules.durationMinutes,
      intervalMinutes: rules.intervalMinutes,
      minNoticeMinutes: rules.minNoticeMinutes,
      rollingWeeks: rules.rollingWeeks,
      timeZone: rules.timeZone,
    },
    slots,
  };
}

export async function createMeetingBookingWithNotifications(
  input: MeetingBookingInput,
): Promise<CreateMeetingBookingResult> {
  if (!hasDatabaseUrl()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const page = await getPublicMeetingPageSettings(input.slug);
  if (!page?.id || !page.workspaceId || !isUuid(page.workspaceId)) {
    return { persisted: false, reason: "Meeting page is not available" };
  }

  const contactName = input.contactName.trim();
  const contactEmail = input.contactEmail.trim().toLowerCase();
  const availability = await getPublicMeetingAvailability({
    date: input.selectedDate,
    slug: input.slug,
  });
  const startsAt = parseBookingStart(
    input.selectedDate,
    input.slot,
    availability?.rules.timeZone,
  );
  if (!contactName || !safeEmail(contactEmail) || !startsAt) {
    return { persisted: false, reason: "Booking data is incomplete" };
  }

  const selectedSlot = availability?.slots.find((slot) => slot.time === input.slot);
  if (!availability || availability.date !== input.selectedDate || !selectedSlot?.available) {
    return { persisted: false, reason: "slot_unavailable" };
  }

  const endsAt = addMinutes(startsAt, availability.rules.durationMinutes);
  const origin = getRequestOrigin(input.requestUrl);
  const automation = asAutomation(page.automation);
  const publicToken = randomUUID();

  const bookingRow = await queryOne<IdRow>(
    `
        insert into meeting_bookings (
          workspace_id,
          meeting_page_id,
          slug,
          title,
          contact_name,
          contact_email,
          contact_note,
          starts_at,
          ends_at,
          calendar_provider,
          meeting_provider,
          source,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        returning id
      `,
    [
      page.workspaceId,
      page.id,
      page.slug,
      page.title,
      contactName,
      contactEmail,
      input.contactNote?.trim() ?? "",
      startsAt.toISOString(),
      endsAt.toISOString(),
      input.calendarProvider,
      input.meetingProvider,
      input.source || "booking_page",
      JSON.stringify({
        allowCancel: Boolean(automation.allowCancel),
        allowReschedule: Boolean(automation.allowReschedule),
        publicToken,
        requestUrl: input.requestUrl,
      }),
    ],
  ).catch((error) => {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) return null;
    throw error;
  });

  if (!bookingRow?.id) {
    return { persisted: false, reason: "slot_unavailable" };
  }

  const tokens = getTokenValues({
    bookingId: bookingRow.id,
    contactEmail,
    contactName,
    meetingProvider: input.meetingProvider,
    origin,
    page,
    publicToken,
    selectedDate: startsAt,
    slot: input.slot,
  });

  let jobsQueued = 0;
  const publicSession = createPublicBookingSession({
    ownerUserId: page.ownerUserId,
    workspaceId: page.workspaceId,
  });
  const confirmation = await confirmMeetingBooking({
    bookingId: bookingRow.id,
    requestUrl: input.requestUrl,
    session: publicSession,
  });

  if (!confirmation.ok || (expectsOnlineMeetingLink(input.meetingProvider) && !confirmation.onlineMeetingUrl)) {
    return {
      autoConfirmed: false,
      bookingId: bookingRow.id,
      confirmationStatus: confirmation.status ?? null,
      persisted: false,
      reason: "calendar_sync_failed",
    };
  }

  const confirmedTokens = confirmation.onlineMeetingUrl
    ? { ...tokens, "{{meeting.link}}": confirmation.onlineMeetingUrl }
    : tokens;
  if (confirmation.finalConfirmationQueued) jobsQueued += 1;

  await queueMeetingBookedTeamsNotification({
    bookingId: bookingRow.id,
    contactEmail,
    contactName,
    meetingTitle: page.title,
    onlineMeetingUrl: confirmation.onlineMeetingUrl ?? null,
    ownerUserId: page.ownerUserId,
    projectId: page.projectId,
    session: publicSession,
    startsAt: startsAt.toISOString(),
  });
  await queueMeetingBookedGoogleNotification({
    bookingId: bookingRow.id,
    contactEmail,
    contactName,
    meetingProvider: input.meetingProvider,
    meetingTitle: page.title,
    onlineMeetingUrl: confirmation.onlineMeetingUrl ?? null,
    ownerUserId: page.ownerUserId,
    projectId: page.projectId,
    session: publicSession,
    startsAt: startsAt.toISOString(),
  });
  await writeCrmAnalyticsEvent({
    channel: input.calendarProvider,
    entityId: bookingRow.id,
    entityType: "meeting_booking",
    eventType: "booking_created",
    metadata: {
      calendarProvider: input.calendarProvider,
      contactEmail,
      contactName,
      meetingPageId: page.id,
      meetingProvider: input.meetingProvider,
      onlineMeetingUrl: confirmation.onlineMeetingUrl ?? null,
      slug: page.slug,
      startsAt: startsAt.toISOString(),
    },
    module: "meeting",
    occurredAt: new Date().toISOString(),
    projectId: page.projectId,
    source: input.source || "booking_page",
    userId: page.ownerUserId,
    workspaceId: page.workspaceId,
  });

  if (automation.reminderEnabled !== false && Array.isArray(automation.reminders)) {
    for (const reminder of automation.reminders) {
      const offsetMinutes = getReminderOffsetMinutes(reminder);
      const scheduledFor = addMinutes(startsAt, -offsetMinutes);
      if (reminder.enabled === false || (reminder.channel && reminder.channel !== "email") || offsetMinutes <= 0) continue;
      if (scheduledFor.getTime() <= Date.now()) continue;

      const queuedId = await queueMeetingNotificationJob({
        body:
          reminder.body ||
          "Hallo {{contact.firstName}},\n\nkurze Erinnerung an {{meeting.title}} um {{meeting.time}}.\n\nLink: {{meeting.link}}",
        bookingId: bookingRow.id,
        kind: "reminder",
        meetingPageId: page.id,
        recipientEmail: contactEmail,
        scheduledFor,
        subject: reminder.subject || "Erinnerung: {{meeting.title}}",
        title: reminder.title || "Terminerinnerung",
        tokens: confirmedTokens,
        workspaceId: page.workspaceId,
      });
      if (queuedId) jobsQueued += 1;
    }
  }

  if (automation.postFollowUpEnabled) {
    const delayHours = Number.parseInt(automation.postFollowUpDelayHours || "2", 10);
    const scheduledFor = addMinutes(endsAt, Number.isFinite(delayHours) ? delayHours * 60 : 120);
    const queuedId = await queueMeetingNotificationJob({
      body:
        "Hallo {{contact.firstName}},\n\nvielen Dank für den Termin. Wir melden uns mit den nächsten Schritten.",
      bookingId: bookingRow.id,
      kind: "follow_up",
      meetingPageId: page.id,
      recipientEmail: contactEmail,
      scheduledFor,
      subject: "Danke für den Termin: {{meeting.title}}",
      title: "Nachfass-Mail",
      tokens: confirmedTokens,
      workspaceId: page.workspaceId,
    });
    if (queuedId) jobsQueued += 1;
  }

  return {
    autoConfirmed: true,
    bookingId: bookingRow.id,
    confirmationStatus: confirmation.status ?? null,
    finalConfirmationJobId: confirmation.finalConfirmationJobId ?? null,
    jobsQueued,
    onlineMeetingUrl: confirmation.onlineMeetingUrl ?? null,
    persisted: true,
  };
}

export async function listMeetingBookingOverview(input: {
  limit?: number;
  session: AppSession;
}): Promise<MeetingBookingOverview> {
  const fallbackMetrics = {
    failedNotifications: 0,
    queuedNotifications: 0,
    requestedBookings: 0,
    sentNotifications: 0,
    totalBookings: 0,
  };

  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return {
      bookings: [],
      metrics: fallbackMetrics,
      notifications: [],
      source: "fallback",
    };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));

  try {
    const [metricRow, bookings, notifications] = await Promise.all([
      queryOne<MeetingBookingOverviewMetricRow>(
        `
          select
            (select count(*)::int from meeting_bookings where workspace_id = $1) as "totalBookings",
            (select count(*)::int from meeting_bookings where workspace_id = $1 and status = 'requested') as "requestedBookings",
            (select count(*)::int from meeting_notification_jobs where workspace_id = $1 and status = 'queued') as "queuedNotifications",
            (select count(*)::int from meeting_notification_jobs where workspace_id = $1 and status = 'sent') as "sentNotifications",
            (select count(*)::int from meeting_notification_jobs where workspace_id = $1 and status = 'failed') as "failedNotifications"
        `,
        [input.session.workspaceId],
      ),
      queryRows<MeetingBookingOverviewBooking>(
        `
          select
            b.id,
            b.slug,
            b.title,
            b.contact_name as "contactName",
            b.contact_email as "contactEmail",
            b.contact_note as "contactNote",
            b.starts_at as "startsAt",
            b.ends_at as "endsAt",
            b.calendar_provider as "calendarProvider",
            b.meeting_provider as "meetingProvider",
            b.status,
            b.source,
            b.created_at as "createdAt",
            mp.slug as "pageSlug"
          from meeting_bookings b
          left join meeting_pages mp on mp.id = b.meeting_page_id
          where b.workspace_id = $1
          order by b.created_at desc
          limit $2
        `,
        [input.session.workspaceId, limit],
      ),
      queryRows<MeetingBookingOverviewNotification>(
        `
          select
            n.id,
            n.booking_id as "bookingId",
            n.kind,
            n.scheduled_for as "scheduledFor",
            n.recipient_email as "recipientEmail",
            n.subject,
            n.status,
            n.provider,
            n.attempts,
            n.error,
            n.sent_at as "sentAt",
            n.tokens,
            b.contact_name as "contactName",
            b.title as "bookingTitle"
          from meeting_notification_jobs n
          left join meeting_bookings b on b.id = n.booking_id
          where n.workspace_id = $1
          order by n.scheduled_for desc
          limit $2
        `,
        [input.session.workspaceId, limit],
      ),
    ]);

    return {
      bookings,
      metrics: {
        failedNotifications: Number(metricRow?.failedNotifications ?? 0),
        queuedNotifications: Number(metricRow?.queuedNotifications ?? 0),
        requestedBookings: Number(metricRow?.requestedBookings ?? 0),
        sentNotifications: Number(metricRow?.sentNotifications ?? 0),
        totalBookings: Number(metricRow?.totalBookings ?? 0),
      },
      notifications,
      source: "database",
    };
  } catch {
    return {
      bookings: [],
      metrics: fallbackMetrics,
      notifications: [],
      source: "fallback",
    };
  }
}

function toPublicMeetingBookingActionState(
  booking: PublicMeetingBookingRow,
): PublicMeetingBookingActionState {
  return {
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    endsAt: booking.endsAt,
    id: booking.id,
    pageSlug: booking.pageSlug,
    startsAt: booking.startsAt,
    status: booking.status,
    title: booking.pageTitle || booking.title,
  };
}

async function getPublicMeetingBookingByToken(input: {
  bookingId: string;
  token: string;
}): Promise<PublicMeetingBookingRow | null> {
  if (!hasDatabaseUrl() || !isUuid(input.bookingId) || !input.token) return null;

  const booking = await queryOne<PublicMeetingBookingRow>(
    `
      select
        b.id,
        b.workspace_id as "workspaceId",
        b.meeting_page_id as "meetingPageId",
        b.slug,
        b.title,
        b.contact_name as "contactName",
        b.contact_email as "contactEmail",
        b.contact_note as "contactNote",
        b.starts_at as "startsAt",
        b.ends_at as "endsAt",
        b.calendar_provider as "calendarProvider",
        b.meeting_provider as "meetingProvider",
        b.status,
        b.metadata,
        mp.slug as "pageSlug",
        mp.title as "pageTitle",
        mp.automation,
        mp.calendar_integrations as "calendarIntegrations"
      from meeting_bookings b
      left join meeting_pages mp on mp.id = b.meeting_page_id
      where b.id = $1
      limit 1
    `,
    [input.bookingId],
  );
  const metadata = getBookingMetadata(booking?.metadata);

  if (!booking || metadata.publicToken !== input.token) return null;
  return booking;
}

function actionAllowed(input: {
  action: "cancel" | "reschedule";
  automation: MeetingAutomationConfig;
  startsAt: string | Date;
}) {
  if (input.action === "cancel" && input.automation.allowCancel === false) return false;
  if (input.action === "reschedule" && input.automation.allowReschedule === false) return false;

  const hours =
    input.action === "cancel"
      ? getNumber(input.automation.cancelDeadlineHours, 24, 0, 8760)
      : getNumber(input.automation.rescheduleDeadlineHours, 12, 0, 8760);
  const deadline = addMinutes(new Date(normalizeDateInput(input.startsAt)), -hours * 60);

  return Date.now() <= deadline.getTime();
}

function getExternalCalendarEventId(metadata: Record<string, unknown>) {
  return typeof metadata.externalCalendarId === "string" && metadata.externalCalendarId.trim()
    ? metadata.externalCalendarId.trim()
    : null;
}

function getExternalCalendarProvider(booking: Pick<PublicMeetingBookingRow, "calendarProvider" | "meetingProvider">) {
  if (booking.calendarProvider === "microsoft" || booking.meetingProvider === "microsoft-teams") {
    return "microsoft";
  }
  if (booking.calendarProvider === "google" || booking.meetingProvider === "google-meet") {
    return "google";
  }
  return null;
}

async function syncExternalCalendarForPublicAction(input: {
  action: "cancel" | "reschedule";
  body?: string;
  booking: PublicMeetingBookingRow;
  endsAt?: string;
  startsAt?: string;
}) {
  const metadata = getBookingMetadata(input.booking.metadata);
  const eventId = getExternalCalendarEventId(metadata);
  const provider = getExternalCalendarProvider(input.booking);

  if (!eventId || !provider) {
    return {
      eventId,
      provider: provider ?? "none",
      status: "skipped" as const,
    };
  }

  const result =
    provider === "google"
      ? input.action === "cancel"
        ? await deleteGoogleCalendarEvent({
            eventId,
            workspaceId: input.booking.workspaceId,
          })
        : await updateGoogleCalendarEvent({
            body: input.body,
            endsAt: input.endsAt ?? normalizeDateInput(input.booking.endsAt),
            eventId,
            location: getCalendarLocation(input.booking.meetingProvider),
            startsAt: input.startsAt ?? normalizeDateInput(input.booking.startsAt),
            subject: input.booking.title,
            workspaceId: input.booking.workspaceId,
          })
      : input.action === "cancel"
        ? await deleteMicrosoftCalendarEvent({
            eventId,
            workspaceId: input.booking.workspaceId,
          })
        : await updateMicrosoftCalendarEvent({
            body: input.body,
            endsAt: input.endsAt ?? normalizeDateInput(input.booking.endsAt),
            eventId,
            location: getCalendarLocation(input.booking.meetingProvider),
            startsAt: input.startsAt ?? normalizeDateInput(input.booking.startsAt),
            subject: input.booking.title,
            workspaceId: input.booking.workspaceId,
          });

  return {
    error: result.error ?? null,
    eventId: result.eventId ?? eventId,
    provider: result.provider,
    status: result.status,
    webLink: result.webLink ?? null,
  };
}

async function updateLocalCalendarEventForPublicAction(input: {
  calendarEventId: unknown;
  metadata: Record<string, unknown>;
  status: "abgesagt" | "bestätigt";
  startsAt?: string;
  endsAt?: string;
}) {
  if (typeof input.calendarEventId !== "string" || !isUuid(input.calendarEventId)) return;

  await queryOne<IdRow>(
    `
      update calendar_events
      set status = $2,
          starts_at = coalesce($3::timestamptz, starts_at),
          ends_at = coalesce($4::timestamptz, ends_at),
          metadata = metadata || $5::jsonb,
          updated_at = now()
      where id = $1
      returning id
    `,
    [
      input.calendarEventId,
      input.status,
      input.startsAt ?? null,
      input.endsAt ?? null,
      JSON.stringify(input.metadata),
    ],
  );
}

export async function getPublicMeetingBookingActionState(input: {
  bookingId: string;
  token: string;
}): Promise<PublicMeetingBookingActionState | null> {
  const booking = await getPublicMeetingBookingByToken(input);
  return booking ? toPublicMeetingBookingActionState(booking) : null;
}

export async function cancelPublicMeetingBooking(input: {
  bookingId: string;
  reason?: string;
  requestUrl: string;
  token: string;
}): Promise<{
  booking?: PublicMeetingBookingActionState;
  error?: string;
  notificationJobId?: string | null;
  ok: boolean;
}> {
  const booking = await getPublicMeetingBookingByToken(input);
  if (!booking) return { error: "booking_not_found", ok: false };
  if (booking.status === "cancelled") {
    return { booking: toPublicMeetingBookingActionState(booking), notificationJobId: null, ok: true };
  }

  const automation = asAutomation(booking.automation);
  if (automation.requireCancelReason && !input.reason?.trim()) {
    return { error: "cancel_reason_required", ok: false };
  }
  if (!actionAllowed({ action: "cancel", automation, startsAt: booking.startsAt })) {
    return { error: "cancel_deadline_passed", ok: false };
  }

  const metadata = getBookingMetadata(booking.metadata);
  const externalSync = await syncExternalCalendarForPublicAction({
    action: "cancel",
    booking,
  });

  if (externalSync.status === "failed") {
    return { error: "calendar_sync_failed", ok: false };
  }

  const actionMetadata = {
    cancelReason: input.reason?.trim() || null,
    cancelledAt: new Date().toISOString(),
    externalCalendarAction: {
      action: "cancel",
      error: externalSync.error ?? null,
      eventId: externalSync.eventId ?? null,
      provider: externalSync.provider,
      status: externalSync.status,
    },
  };

  await queryOne<IdRow>(
    `
      update meeting_bookings
      set status = 'cancelled',
          metadata = metadata || $2::jsonb,
          updated_at = now()
      where id = $1
      returning id
    `,
    [
      booking.id,
      JSON.stringify(actionMetadata),
    ],
  );
  await updateLocalCalendarEventForPublicAction({
    calendarEventId: metadata.calendarEventId,
    metadata: actionMetadata,
    status: "abgesagt",
  });
  await queryOne<IdRow>(
    `
      update meeting_notification_jobs
      set status = 'cancelled', updated_at = now()
      where booking_id = $1 and status in ('queued', 'sending')
      returning id
    `,
    [booking.id],
  );

  let notificationJobId: string | null = null;
  if (booking.meetingPageId && automation.confirmationEnabled !== false) {
    const origin = getRequestOrigin(input.requestUrl);
    const page: MeetingPageSettings = {
      automation: booking.automation,
      calendarIntegrations: booking.calendarIntegrations,
      id: booking.meetingPageId,
      shareConfig: {},
      slug: booking.pageSlug || booking.slug,
      title: booking.pageTitle || booking.title,
      workspaceId: booking.workspaceId,
    };
    const tokens = getTokenValues({
      bookingId: booking.id,
      contactEmail: booking.contactEmail,
      contactName: booking.contactName,
      meetingProvider: booking.meetingProvider,
      origin,
      page,
      publicToken: input.token,
      selectedDate: new Date(normalizeDateInput(booking.startsAt)),
      slot: formatMeetingTime(booking.startsAt),
    });

    notificationJobId = await queueMeetingNotificationJob({
      body:
        "Hallo {{contact.firstName}},\n\nIhr Termin {{meeting.title}} wurde abgesagt.\n\nTermin: {{meeting.date}} um {{meeting.time}}\nOrt: {{meeting.location}}",
      bookingId: booking.id,
      kind: "confirmation",
      meetingPageId: booking.meetingPageId,
      recipientEmail: booking.contactEmail,
      scheduledFor: new Date(),
      subject: "Termin abgesagt: {{meeting.title}}",
      title: "Termin abgesagt",
      tokens,
      workspaceId: booking.workspaceId,
    });
  }

  return {
    booking: { ...toPublicMeetingBookingActionState(booking), status: "cancelled" },
    notificationJobId,
    ok: true,
  };
}

export async function reschedulePublicMeetingBooking(input: {
  bookingId: string;
  requestUrl: string;
  selectedDate: string;
  slot: string;
  token: string;
}): Promise<{
  booking?: PublicMeetingBookingActionState;
  error?: string;
  notificationJobId?: string | null;
  ok: boolean;
}> {
  const booking = await getPublicMeetingBookingByToken(input);
  if (!booking) return { error: "booking_not_found", ok: false };
  if (!booking.pageSlug) return { error: "meeting_page_missing", ok: false };

  const automation = asAutomation(booking.automation);
  if (!actionAllowed({ action: "reschedule", automation, startsAt: booking.startsAt })) {
    return { error: "reschedule_deadline_passed", ok: false };
  }

  const availability = await getPublicMeetingAvailability({
    date: input.selectedDate,
    slug: booking.pageSlug,
  });
  const selectedSlot = availability?.slots.find((slot) => slot.time === input.slot);
  const startsAt = parseBookingStart(
    input.selectedDate,
    input.slot,
    availability?.rules.timeZone,
  );
  if (!availability || !selectedSlot?.available || !startsAt) {
    return { error: "slot_unavailable", ok: false };
  }
  const endsAt = addMinutes(startsAt, availability.rules.durationMinutes);
  const origin = getRequestOrigin(input.requestUrl);
  const page: MeetingPageSettings = {
    automation: booking.automation,
    calendarIntegrations: booking.calendarIntegrations,
    id: booking.meetingPageId ?? undefined,
    shareConfig: {},
    slug: booking.pageSlug,
    title: booking.pageTitle || booking.title,
    workspaceId: booking.workspaceId,
  };
  const tokens = getTokenValues({
    bookingId: booking.id,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    meetingProvider: booking.meetingProvider,
    origin,
    page,
    publicToken: input.token,
    selectedDate: startsAt,
    slot: input.slot,
  });
  const metadata = getBookingMetadata(booking.metadata);
  const externalSync = await syncExternalCalendarForPublicAction({
    action: "reschedule",
    body: [
      `<p>Termin aus Novalure CRM Buchungsseite wurde verschoben.</p>`,
      booking.contactNote ? `<p>${booking.contactNote}</p>` : "",
    ].join(""),
    booking,
    endsAt: endsAt.toISOString(),
    startsAt: startsAt.toISOString(),
  });

  if (externalSync.status === "failed") {
    return { error: "calendar_sync_failed", ok: false };
  }

  const actionMetadata = {
    externalCalendarAction: {
      action: "reschedule",
      error: externalSync.error ?? null,
      eventId: externalSync.eventId ?? null,
      provider: externalSync.provider,
      status: externalSync.status,
      webLink: externalSync.webLink ?? null,
    },
    previousStartsAt: normalizeDateInput(booking.startsAt),
    rescheduledAt: new Date().toISOString(),
  };

  await queryOne<IdRow>(
    `
      update meeting_bookings
      set status = 'rescheduled',
          starts_at = $2,
          ends_at = $3,
          metadata = metadata || $4::jsonb,
          updated_at = now()
      where id = $1
      returning id
    `,
    [
      booking.id,
      startsAt.toISOString(),
      endsAt.toISOString(),
      JSON.stringify(actionMetadata),
    ],
  );
  await updateLocalCalendarEventForPublicAction({
    calendarEventId: metadata.calendarEventId,
    endsAt: endsAt.toISOString(),
    metadata: actionMetadata,
    startsAt: startsAt.toISOString(),
    status: "bestätigt",
  });
  await queryOne<IdRow>(
    `
      update meeting_notification_jobs
      set status = 'cancelled', updated_at = now()
      where booking_id = $1 and status in ('queued', 'sending')
      returning id
    `,
    [booking.id],
  );

  let notificationJobId: string | null = null;
  if (booking.meetingPageId && automation.confirmationEnabled !== false) {
    const onlineMeetingUrl =
      typeof metadata.onlineMeetingUrl === "string" && metadata.onlineMeetingUrl.trim()
        ? metadata.onlineMeetingUrl.trim()
        : null;

    notificationJobId = await queueMeetingNotificationJob({
      body:
        "Hallo {{contact.firstName}},\n\nIhr Termin wurde verschoben.\n\nNeuer Termin: {{meeting.date}} um {{meeting.time}}\nOrt: {{meeting.location}}\nLink: {{meeting.link}}\n\nTermin erneut verschieben: {{meeting.rescheduleLink}}\nTermin absagen: {{meeting.cancelLink}}",
      bookingId: booking.id,
      kind: "confirmation",
      meetingPageId: booking.meetingPageId,
      recipientEmail: booking.contactEmail,
      scheduledFor: new Date(),
      subject: "Termin verschoben: {{meeting.title}}",
      title: "Termin verschoben",
      tokens: onlineMeetingUrl ? { ...tokens, "{{meeting.link}}": onlineMeetingUrl } : tokens,
      workspaceId: booking.workspaceId,
    });
  }

  return {
    booking: {
      ...toPublicMeetingBookingActionState(booking),
      endsAt,
      startsAt,
      status: "rescheduled",
    },
    notificationJobId,
    ok: true,
  };
}

export async function retryMeetingNotificationJob(input: {
  notificationId: string;
  session: AppSession;
}): Promise<{ error?: string; jobId?: string; ok: boolean }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId) || !isUuid(input.notificationId)) {
    return { error: "invalid_notification", ok: false };
  }

  const row = await queryOne<IdRow>(
    `
      update meeting_notification_jobs
      set status = 'queued',
          scheduled_for = now(),
          error = null,
          updated_at = now()
      where id = $1
        and workspace_id = $2
        and status = 'failed'
      returning id
    `,
    [input.notificationId, input.session.workspaceId],
  );

  return row?.id
    ? { jobId: row.id, ok: true }
    : { error: "notification_not_found_or_not_failed", ok: false };
}

function getBookingMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function getCalendarLocation(meetingProvider: string) {
  if (meetingProvider === "google-meet") return "Google Meet";
  if (meetingProvider === "phone") return "Telefon";
  if (meetingProvider === "manual-link") return "Extern";
  return "Teams";
}

function normalizeDateInput(value: string | Date) {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function insertCalendarEventForBooking(input: {
  booking: MeetingBookingConfirmationRow;
  metadata: Record<string, unknown>;
}) {
  const row = await queryOne<IdRow>(
    `
      insert into calendar_events (
        workspace_id,
        project_id,
        contact_id,
        owner_user_id,
        title,
        starts_at,
        ends_at,
        location,
        status,
        preparation,
        outcome_goal,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'bestätigt', $9::jsonb, $10, $11::jsonb)
      returning id
    `,
    [
      input.booking.workspaceId,
      input.booking.projectId,
      input.booking.contactId,
      input.booking.ownerUserId,
      input.booking.title,
      normalizeDateInput(input.booking.startsAt),
      normalizeDateInput(input.booking.endsAt),
      getCalendarLocation(input.booking.meetingProvider),
      JSON.stringify([
        "Buchung aus Terminseite prüfen",
        "Kontakt und Ziel vor dem Termin vorbereiten",
        "Meetinglink vor Start kontrollieren",
      ]),
        `Termin mit ${input.booking.contactName} bestätigen und nächste Schritte klären.`,
      JSON.stringify(input.metadata),
    ],
  );

  return row?.id ?? null;
}

async function updateCalendarEventAfterSync(input: {
  calendarEventId: string;
  metadata: Record<string, unknown>;
  teamsJoinUrl?: string | null;
}) {
  await queryOne<IdRow>(
    `
      update calendar_events
      set teams_join_url = $2, metadata = $3::jsonb, updated_at = now()
      where id = $1
      returning id
    `,
    [input.calendarEventId, input.teamsJoinUrl ?? null, JSON.stringify(input.metadata)],
  );
}

export async function confirmMeetingBooking(input: {
  bookingId: string;
  requestUrl?: string;
  session: AppSession;
}): Promise<{
  bookingId?: string;
  calendarEventId?: string | null;
  error?: string | null;
  finalConfirmationJobId?: string | null;
  finalConfirmationQueued?: boolean;
  ok: boolean;
  onlineMeetingUrl?: string | null;
  provider?: string | null;
  status?: string;
  syncId?: string | null;
  webLink?: string | null;
}> {
  if (!hasDatabaseUrl()) return { error: "DATABASE_URL is not configured", ok: false };
  if (!isUuid(input.session.workspaceId) || !isUuid(input.bookingId)) {
    return { error: "Invalid booking", ok: false };
  }

  const booking = await queryOne<MeetingBookingConfirmationRow>(
    `
      select
        b.id,
        b.workspace_id as "workspaceId",
        b.meeting_page_id as "meetingPageId",
        b.slug,
        b.title,
        b.contact_name as "contactName",
        b.contact_email as "contactEmail",
        b.contact_note as "contactNote",
        b.starts_at as "startsAt",
        b.ends_at as "endsAt",
        b.calendar_provider as "calendarProvider",
        b.meeting_provider as "meetingProvider",
        b.status,
        b.metadata,
        mp.slug as "pageSlug",
        mp.title as "pageTitle",
        mp.automation,
        mp.project_id as "projectId",
        mp.owner_user_id as "ownerUserId",
        (
          select c.id
          from contacts c
          where c.workspace_id = b.workspace_id
            and c.email is not null
            and lower(c.email) = lower(b.contact_email)
          order by c.updated_at desc
          limit 1
        ) as "contactId"
      from meeting_bookings b
      left join meeting_pages mp on mp.id = b.meeting_page_id
      where b.id = $1 and b.workspace_id = $2
      limit 1
    `,
    [input.bookingId, input.session.workspaceId],
  );

  if (!booking) return { error: "Booking not found", ok: false };

  const metadata = getBookingMetadata(booking.metadata);
  let calendarEventId =
    typeof metadata.calendarEventId === "string" && isUuid(metadata.calendarEventId)
      ? metadata.calendarEventId
      : null;

  if (!calendarEventId) {
    calendarEventId = await insertCalendarEventForBooking({
      booking,
      metadata: {
        bookingId: booking.id,
        calendarProvider: booking.calendarProvider,
        contactEmail: booking.contactEmail,
        meetingProvider: booking.meetingProvider,
        source: "meeting_booking",
      },
    });
  }

  if (!calendarEventId) return { error: "Calendar event could not be created", ok: false };

  const shouldUseMicrosoft =
    booking.calendarProvider === "microsoft" || booking.meetingProvider === "microsoft-teams";
  const shouldUseGoogle =
    booking.calendarProvider === "google" || booking.meetingProvider === "google-meet";
  const syncResult = shouldUseMicrosoft
    ? await syncMicrosoftCalendarEvent({
        attendees: [booking.contactEmail],
        body: [
          `<p>Termin aus Novalure CRM Buchungsseite.</p>`,
          booking.contactNote ? `<p>${booking.contactNote}</p>` : "",
        ].join(""),
        createOnlineMeeting: booking.meetingProvider === "microsoft-teams",
        endsAt: normalizeDateInput(booking.endsAt),
        location: getCalendarLocation(booking.meetingProvider),
        startsAt: normalizeDateInput(booking.startsAt),
        subject: booking.title,
        workspaceId: booking.workspaceId,
      })
    : shouldUseGoogle
      ? await syncGoogleCalendarEvent({
          attendees: [booking.contactEmail],
          body: [
            `<p>Termin aus Novalure CRM Buchungsseite.</p>`,
            booking.contactNote ? `<p>${booking.contactNote}</p>` : "",
          ].join(""),
          createOnlineMeeting: booking.meetingProvider === "google-meet",
          endsAt: normalizeDateInput(booking.endsAt),
          location: getCalendarLocation(booking.meetingProvider),
          startsAt: normalizeDateInput(booking.startsAt),
          subject: booking.title,
          workspaceId: booking.workspaceId,
        })
      : {
          error: "Provider sync is prepared but not connected yet",
          eventId: null,
          onlineMeetingUrl: null,
          provider: "manual",
          status: "pending" as const,
          webLink: null,
        };
  const missingOnlineMeetingUrl =
    syncResult.status === "synced" &&
    expectsOnlineMeetingLink(booking.meetingProvider) &&
    !syncResult.onlineMeetingUrl;
  const syncStatus: "failed" | "pending" | "synced" = missingOnlineMeetingUrl
    ? "failed"
    : syncResult.status;
  const syncError = missingOnlineMeetingUrl
    ? `${getMeetingLocation(booking.meetingProvider)} konnte keinen Meeting-Link erstellen.`
    : syncResult.error ?? null;

  const mergedMetadata = {
    ...metadata,
    calendarEventId,
    externalCalendarId: syncResult.eventId ?? null,
    onlineMeetingUrl: syncResult.onlineMeetingUrl ?? null,
    provider: syncResult.provider,
    syncStatus,
    webLink: syncResult.webLink ?? null,
  };

  await updateCalendarEventAfterSync({
    calendarEventId,
    metadata: {
      ...mergedMetadata,
      calendarProvider: booking.calendarProvider,
      googleMeetJoinUrl: booking.meetingProvider === "google-meet" ? syncResult.onlineMeetingUrl ?? null : null,
      meetingProvider: booking.meetingProvider,
    },
    teamsJoinUrl: booking.meetingProvider === "microsoft-teams" ? syncResult.onlineMeetingUrl ?? null : null,
  });

  const syncId = await insertCalendarSyncEvent({
    calendarEventId,
    error: syncError,
    operation: "confirm_meeting_booking",
    payload: {
      bookingId: booking.id,
      contactEmail: booking.contactEmail,
      onlineMeetingUrl: syncResult.onlineMeetingUrl ?? null,
      providerEventId: syncResult.eventId ?? null,
      webLink: syncResult.webLink ?? null,
    },
    provider: syncResult.provider,
    providerEventId: syncResult.eventId ?? null,
    session: input.session,
    status: syncStatus,
  });

  if (syncStatus === "failed") {
    await queryOne<IdRow>(
      `
        update meeting_bookings
        set metadata = metadata || $2::jsonb, updated_at = now()
        where id = $1
        returning id
      `,
      [
        booking.id,
        JSON.stringify({
          ...mergedMetadata,
          syncError: syncError ?? "Calendar sync failed",
        }),
      ],
    );

    return {
      bookingId: booking.id,
      calendarEventId,
      error: syncError ?? "Calendar sync failed",
      finalConfirmationJobId: null,
      finalConfirmationQueued: false,
      ok: false,
      provider: syncResult.provider,
      status: syncStatus,
      syncId,
    };
  }

  const automation = asAutomation(booking.automation);
  let finalConfirmationJobId: string | null = null;
  const existingFinalConfirmationJobId =
    typeof metadata.finalConfirmationJobId === "string" ? metadata.finalConfirmationJobId : null;
  const shouldQueueFinalConfirmation =
    automation.confirmationEnabled !== false &&
    Boolean(booking.meetingPageId) &&
    Boolean(syncResult.onlineMeetingUrl) &&
    !existingFinalConfirmationJobId;

  if (shouldQueueFinalConfirmation && booking.meetingPageId && syncResult.onlineMeetingUrl) {
    const defaultBody =
      "Hallo {{contact.firstName}},\n\nIhr Termin {{meeting.title}} ist bestätigt.\n\nDatum: {{meeting.date}}\nUhrzeit: {{meeting.time}}\nOrt: {{meeting.location}}\nLink: {{meeting.link}}\n\nTermin verschieben: {{meeting.rescheduleLink}}\nTermin absagen: {{meeting.cancelLink}}";
    const finalBody = ensureMeetingActionLinksInBody(
      ensureMeetingLinkInBody(automation.confirmationBody || defaultBody),
      automation,
    );

    finalConfirmationJobId = await queueMeetingNotificationJob({
      body: finalBody,
      bookingId: booking.id,
      kind: "confirmation",
      meetingPageId: booking.meetingPageId,
      recipientEmail: booking.contactEmail,
      scheduledFor: new Date(),
    subject: automation.confirmationSubject || "Ihr Termin ist bestätigt: {{meeting.title}}",
    title: automation.confirmationTitle || "Termin bestätigt",
      tokens: getFinalConfirmationTokens({
        booking,
        onlineMeetingUrl: syncResult.onlineMeetingUrl,
        origin: getRequestOrigin(input.requestUrl),
      }),
      workspaceId: booking.workspaceId,
    });
  }

  await queryOne<IdRow>(
    `
      update meeting_bookings
      set status = 'confirmed', metadata = metadata || $2::jsonb, updated_at = now()
      where id = $1
      returning id
    `,
    [
      booking.id,
      JSON.stringify({
        ...mergedMetadata,
        finalConfirmationJobId: finalConfirmationJobId ?? existingFinalConfirmationJobId,
        finalConfirmationQueuedAt: finalConfirmationJobId ? new Date().toISOString() : metadata.finalConfirmationQueuedAt,
      }),
    ],
  );

  await writeAuditLog({
    action: "meeting_booking.confirmed",
    after: {
      bookingId: booking.id,
      calendarEventId,
      finalConfirmationJobId,
      finalConfirmationQueued: Boolean(finalConfirmationJobId),
      provider: syncResult.provider,
      status: syncStatus,
    },
    entityId: booking.id,
    entityType: "meeting_booking",
    session: input.session,
  });

  return {
    bookingId: booking.id,
    calendarEventId,
    finalConfirmationJobId,
    finalConfirmationQueued: Boolean(finalConfirmationJobId),
    ok: true,
    onlineMeetingUrl: syncResult.onlineMeetingUrl ?? null,
    provider: syncResult.provider,
    status: syncStatus,
    syncId,
    webLink: syncResult.webLink ?? null,
  };
}

function toMeetingNotificationJob(row: MeetingNotificationJobRow): MeetingNotificationJob {
  return {
    body: row.body,
    bookingId: row.bookingId,
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    recipientEmail: row.recipientEmail,
    scheduledFor: row.scheduledFor,
    subject: row.subject,
    title: row.title,
    tokens: asTokens(row.tokens),
  };
}

export async function listDueMeetingNotificationJobs(limit = 25): Promise<MeetingNotificationJob[]> {
  if (!hasDatabaseUrl()) return [];

  const rows = await queryRows<MeetingNotificationJobRow>(
    `
      select
        id,
        booking_id as "bookingId",
        kind,
        scheduled_for as "scheduledFor",
        recipient_email as "recipientEmail",
        subject,
        title,
        body,
        tokens,
        provider
      from meeting_notification_jobs
      where status = 'queued' and scheduled_for <= now()
      order by scheduled_for asc
      limit $1
    `,
    [limit],
  );

  return rows.map(toMeetingNotificationJob);
}

export async function claimMeetingNotificationJob(id: string): Promise<MeetingNotificationJob | null> {
  if (!hasDatabaseUrl() || !isUuid(id)) return null;

  const row = await queryOne<MeetingNotificationJobRow>(
    `
      update meeting_notification_jobs
      set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id = $1 and status = 'queued'
      returning
        id,
        booking_id as "bookingId",
        kind,
        scheduled_for as "scheduledFor",
        recipient_email as "recipientEmail",
        subject,
        title,
        body,
        tokens,
        provider
    `,
    [id],
  );

  return row ? toMeetingNotificationJob(row) : null;
}

export async function markMeetingNotificationJobSent(input: {
  id: string;
  messageId?: string | null;
  provider: string;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.id)) return;

  await queryOne<IdRow>(
    `
      update meeting_notification_jobs
      set
        status = 'sent',
        provider = $2,
        provider_message_id = $3,
        sent_at = now(),
        updated_at = now(),
        error = null
      where id = $1
      returning id
    `,
    [input.id, input.provider, input.messageId ?? null],
  );
}

export async function markMeetingNotificationJobFailed(input: { error: string; id: string }) {
  if (!hasDatabaseUrl() || !isUuid(input.id)) return;

  await queryOne<IdRow>(
    `
      update meeting_notification_jobs
      set status = 'failed', error = $2, updated_at = now()
      where id = $1
      returning id
    `,
    [input.id, input.error],
  );
}

export async function countQueuedMeetingNotificationJobs() {
  if (!hasDatabaseUrl()) return 0;

  const row = await queryOne<CountRow>(
    `
      select count(*)::int as count
      from meeting_notification_jobs
      where status = 'queued'
    `,
  );

  return Number(row?.count ?? 0);
}

export function renderMeetingNotificationTemplate(input: {
  body: string;
  subject: string;
  title: string;
  tokens: Record<string, string>;
}) {
  return {
    body: resolveTokens(input.body, input.tokens),
    subject: resolveTokens(input.subject, input.tokens),
    title: resolveTokens(input.title, input.tokens),
  };
}
