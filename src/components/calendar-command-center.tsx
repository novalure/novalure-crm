"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, Contact, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import {
  getCalendarCommandCenterCopy,
  getCrmEnumLabel,
  getCrmSystemTextLabel,
  getCrmTaskDueLabel,
  getCrmTaskPriorityLabel,
  getLocale,
  type LanguageCode,
} from "@/lib/i18n";

type CalendarCommandCenterProps = {
  contacts: Contact[];
  events: CalendarEvent[];
  language: LanguageCode;
  leads: Lead[];
  onEventsChanged?: () => Promise<void> | void;
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
  workspacePublicKey?: string;
};

type CalendarCommandCenterCopy = ReturnType<typeof getCalendarCommandCenterCopy>;

type CalendarView = "today" | "upcoming" | "prepare" | "teams" | "followUp" | "bookings";

type CalendarProvider = "microsoft" | "google";

type MeetingProvider = "microsoft-teams" | "google-meet" | "manual-link" | "phone";

type MeetingShareMode = "link" | "embed" | "button" | "qr" | "message";

type MeetingType = "personal" | "group" | "round_robin";

type NotificationFilter = "all" | "queued" | "sent" | "failed";

type MeetingAutomationStep =
  | "overview"
  | "confirmation"
  | "reminders"
  | "reschedule"
  | "templates";

type ReminderChannel = "email" | "sms" | "whatsapp";

type ReminderUnit = "minutes" | "hours" | "days" | "weeks";

type EmailImageMode = "host" | "company" | "custom" | "none";

type MeetingTemplateKey = "first-call" | "viewing" | "consulting" | "demo" | "follow-up";

type CalendarConnectionConfig = {
  accountEmail: string;
  calendarId: string;
  calendarUrl: string;
  connected: boolean;
  error?: string | null;
  meetingConnected: boolean;
  meetingLinkTemplate: string;
};

type CalendarOAuthConnectionPayload = {
  accountLabel?: string | null;
  connected?: boolean;
  error?: string | null;
};

type CalendarIntegrationState = {
  defaultMeetingProvider: MeetingProvider;
  defaultProvider: CalendarProvider;
  google: CalendarConnectionConfig;
  microsoft: CalendarConnectionConfig;
  syncMode: "two_way" | "crm_to_calendar" | "read_only";
};

type MeetingShareConfig = {
  buttonLabel: string;
  height: string;
  meetingType: MeetingType;
  slug: string;
  theme: "light" | "dark";
  utmSource: string;
};

type MeetingReminderConfig = {
  amount: string;
  body: string;
  channel: ReminderChannel;
  enabled: boolean;
  id: string;
  subject: string;
  title: string;
  unit: ReminderUnit;
};

type MeetingAutomationConfig = {
  allowCancel: boolean;
  allowReschedule: boolean;
  cancelDeadlineHours: string;
  confirmationBody: string;
  confirmationEnabled: boolean;
  confirmationImageMode: EmailImageMode;
  confirmationSubject: string;
  confirmationTitle: string;
  postFollowUpDelayHours: string;
  postFollowUpEnabled: boolean;
  reminderEnabled: boolean;
  reminders: MeetingReminderConfig[];
  requireCancelReason: boolean;
  rescheduleDeadlineHours: string;
  templateKey: MeetingTemplateKey;
};

type EmailDraftPreview = {
  body: string;
  subject: string;
  title: string;
};

type MeetingSettingsSaveStatus = "idle" | "loading" | "saving" | "saved" | "error";

type MeetingNotificationStatus = "idle" | "sending" | "queued" | "sent" | "error";

type NewCalendarEventDraft = {
  contactId: string;
  endsAt: string;
  leadId: string;
  location: CalendarEvent["location"];
  meetingProvider: MeetingProvider;
  notes: string;
  outcomeGoal: string;
  ownerUserId: string;
  projectId: string;
  startsAt: string;
  status: CalendarEvent["status"];
  title: string;
};

type MeetingSettingsApiPayload = {
  page?: {
    automation?: MeetingAutomationConfig;
    calendarIntegrations?: CalendarIntegrationState;
    meetingType?: MeetingType;
    shareConfig?: MeetingShareConfig;
  } | null;
};

type MeetingBookingOverviewBooking = {
  calendarProvider: string;
  contactEmail: string;
  contactName: string;
  contactNote: string;
  createdAt: string;
  endsAt: string;
  id: string;
  meetingProvider: string;
  pageSlug: string | null;
  slug: string;
  source: string;
  startsAt: string;
  status: string;
  title: string;
};

type MeetingBookingOverviewNotification = {
  attempts: number;
  bookingId: string | null;
  bookingTitle: string | null;
  contactName: string | null;
  error: string | null;
  id: string;
  kind: "confirmation" | "reminder" | "follow_up";
  provider: string | null;
  recipientEmail: string;
  scheduledFor: string;
  sentAt: string | null;
  status: string;
  subject: string;
  tokens?: Record<string, string> | null;
};

type MeetingBookingOverviewPayload = {
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

type LiveCalendarActionState = {
  detail?: string | null;
  status: "idle" | "running" | "success" | "error";
  url?: string | null;
};

function getInitialLiveCalendarAction(text: CalendarCommandCenterCopy): LiveCalendarActionState {
  if (typeof window === "undefined") return { status: "idle" };

  const params = new URLSearchParams(window.location.search);
  const connected = getCalendarProviderFromSearchParam("calendar_connected");
  const error = params.get("calendar_error");

  if (connected) {
    return {
      detail: text.messages.calendarConnected(getCalendarProviderLabel(connected, text)),
      status: "success",
    };
  }

  if (error) {
    return { detail: error, status: "error" };
  }

  return { status: "idle" };
}

function getCalendarProviderFromSearchParam(name: string): CalendarProvider | null {
  if (typeof window === "undefined") return null;

  const value = new URLSearchParams(window.location.search).get(name);
  return value === "google" || value === "microsoft" ? value : null;
}

function getProviderSelectionStatusLabel(
  selectedForPage: boolean,
  connected: boolean,
  text: CalendarCommandCenterCopy,
) {
  if (!connected) return text.providerSelection.notConnected;
  if (selectedForPage) return text.providerSelection.selectedForPage;
  return text.providerSelection.connected;
}

function mergeOAuthConnectionStatus(
  current: CalendarConnectionConfig,
  oauth: CalendarOAuthConnectionPayload | undefined,
) {
  const connected = Boolean(oauth?.connected);

  return {
    ...current,
    accountEmail: connected ? oauth?.accountLabel || current.accountEmail : current.accountEmail,
    calendarId: connected ? current.calendarId || "primary" : current.calendarId,
    connected,
    error: oauth?.error ?? current.error ?? null,
    meetingConnected: connected,
  } satisfies CalendarConnectionConfig;
}

type LiveCalendarResponse = {
  error?: string | null;
  ok?: boolean;
  onlineMeetingUrl?: string | null;
  status?: string | null;
  webLink?: string | null;
};

const statusStyles = {
  geplant: "border-blue-200 bg-blue-50 text-blue-900",
  vorbereiten: "border-amber-200 bg-amber-50 text-amber-900",
  bestätigt: "border-emerald-200 bg-emerald-50 text-emerald-900",
  nachfassen: "border-red-200 bg-red-50 text-red-900",
} as const;

const publicBookingOrigin = (
  process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://www.novalure-crm.app"
).replace(/\/$/, "");

const meetingTokenOptions = [
  "{{contact.firstName}}",
  "{{contact.email}}",
  "{{host.name}}",
  "{{meeting.title}}",
  "{{meeting.date}}",
  "{{meeting.time}}",
  "{{meeting.location}}",
  "{{meeting.link}}",
  "{{meeting.rescheduleLink}}",
  "{{meeting.cancelLink}}",
];

function mergeCalendarConnectionConfig(
  saved: CalendarConnectionConfig | undefined,
  current: CalendarConnectionConfig,
) {
  const connected = current.connected;
  const meetingConnected = current.meetingConnected || connected;

  return {
    ...current,
    ...saved,
    accountEmail: current.accountEmail || saved?.accountEmail || "",
    calendarId: connected ? current.calendarId || saved?.calendarId || "primary" : saved?.calendarId ?? current.calendarId,
    connected,
    error: connected ? (current.error ?? null) : (saved?.error ?? current.error ?? null),
    meetingConnected,
  } satisfies CalendarConnectionConfig;
}

function mergeCalendarIntegrations(
  saved: CalendarIntegrationState,
  current: CalendarIntegrationState,
  preferredProvider?: CalendarProvider | null,
) {
  const merged = {
    ...current,
    ...saved,
    google: mergeCalendarConnectionConfig(saved.google, current.google),
    microsoft: mergeCalendarConnectionConfig(saved.microsoft, current.microsoft),
  } satisfies CalendarIntegrationState;

  return normalizeCalendarIntegrationSelection(merged, preferredProvider);
}

function getMeetingProviderForCalendar(provider: CalendarProvider): MeetingProvider {
  return provider === "google" ? "google-meet" : "microsoft-teams";
}

function normalizeCalendarIntegrationSelection(
  state: CalendarIntegrationState,
  selectedProvider?: CalendarProvider | null,
) {
  const defaultProvider = selectedProvider ?? state.defaultProvider;

  const expectedMeetingProvider = getMeetingProviderForCalendar(defaultProvider);
  const meetingMatchesProvider =
    (defaultProvider === "google" && state.defaultMeetingProvider === "google-meet") ||
    (defaultProvider === "microsoft" && state.defaultMeetingProvider === "microsoft-teams");

  return {
    ...state,
    defaultMeetingProvider: meetingMatchesProvider
      ? state.defaultMeetingProvider
      : expectedMeetingProvider,
    defaultProvider,
  } satisfies CalendarIntegrationState;
}

const emptyMeetingBookingOverview: MeetingBookingOverviewPayload = {
  bookings: [],
  metrics: {
    failedNotifications: 0,
    queuedNotifications: 0,
    requestedBookings: 0,
    sentNotifications: 0,
    totalBookings: 0,
  },
  notifications: [],
  source: "fallback",
};


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

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getCalendarProviderLabel(provider: CalendarProvider, text: CalendarCommandCenterCopy) {
  return text.calendarProviders.find((option) => option.id === provider)?.label ?? provider;
}

function getMeetingProviderLabel(provider: MeetingProvider, text: CalendarCommandCenterCopy) {
  return text.meetingProviderLabels[provider] ?? text.meetingProviderLabels.fallback;
}

function getEventCalendarProvider(
  event: CalendarEvent | undefined,
  fallback: CalendarProvider,
): CalendarProvider {
  if (event?.calendarProvider === "google" || event?.location === "Google Meet" || event?.googleMeetJoinUrl) {
    return "google";
  }

  if (event?.calendarProvider === "microsoft" || event?.location === "Teams" || event?.teamsJoinUrl) {
    return "microsoft";
  }

  return fallback;
}

function isOnlineMeeting(event: CalendarEvent) {
  return (
    event.location === "Teams" ||
    event.location === "Google Meet" ||
    Boolean(event.teamsJoinUrl) ||
    Boolean(event.googleMeetJoinUrl)
  );
}

function hasOnlineMeetingLink(event: CalendarEvent) {
  return Boolean(event.teamsJoinUrl || event.googleMeetJoinUrl);
}

function getMeetingStatusLabel(event: CalendarEvent | undefined, text: CalendarCommandCenterCopy) {
  if (!event) return text.meetingStatusLabels.none;
  if (event.googleMeetJoinUrl) return text.meetingStatusLabels.googleReady;
  if (event.location === "Google Meet") return text.meetingStatusLabels.googleMissing;
  if (event.teamsJoinUrl) return text.meetingStatusLabels.teamsReady;
  if (event.location === "Teams") return text.meetingStatusLabels.teamsMissing;
  if (event.location === "Telefon") return text.meetingStatusLabels.phone;
  return text.meetingStatusLabels.missing;
}

function escapeHtml(value: string | undefined) {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveMeetingTokens(value: string, tokens: Record<string, string>) {
  return Object.entries(tokens).reduce(
    (current, [token, replacement]) => current.replaceAll(token, replacement),
    value,
  );
}

function resolveNotificationSubject(notification: MeetingBookingOverviewNotification) {
  return resolveMeetingTokens(notification.subject, notification.tokens ?? {});
}

function formatReminderSchedule(
  reminder: Pick<MeetingReminderConfig, "amount" | "unit">,
  text: CalendarCommandCenterCopy,
) {
  const unitLabel =
    text.reminderUnits.find((option) => option.id === reminder.unit)?.label ??
    text.reminderUnits[1].label;

  return `${reminder.amount || "0"} ${unitLabel}`;
}

function getBookingStatusLabel(status: string, text: CalendarCommandCenterCopy) {
  if (status === "confirmed") return text.bookingStatusLabels.confirmed;
  if (status === "rescheduled") return text.bookingStatusLabels.rescheduled;
  if (status === "cancelled") return text.bookingStatusLabels.cancelled;
  return text.bookingStatusLabels.requested;
}

function getNotificationKindLabel(
  kind: MeetingBookingOverviewNotification["kind"],
  text: CalendarCommandCenterCopy,
) {
  if (kind === "confirmation") return text.notificationKindLabels.confirmation;
  if (kind === "follow_up") return text.notificationKindLabels.follow_up;
  return text.notificationKindLabels.reminder;
}

function getNotificationStatusLabel(status: string, text: CalendarCommandCenterCopy) {
  if (status === "sent") return text.notificationStatusLabels.sent;
  if (status === "sending") return text.notificationStatusLabels.sending;
  if (status === "failed") return text.notificationStatusLabels.failed;
  if (status === "cancelled") return text.notificationStatusLabels.cancelled;
  return text.notificationStatusLabels.queued;
}

function getNotificationStatusClass(status: string) {
  if (status === "sent") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-900";
  if (status === "sending") return "border-blue-200 bg-blue-50 text-blue-900";
  if (status === "cancelled") return "border-stone-200 bg-stone-100 text-stone-700";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function getMeetingActionErrorMessage(
  error: string | null | undefined,
  fallback: string,
  text: CalendarCommandCenterCopy,
) {
  const value = error?.toLowerCase() ?? "";

  if (value.includes("calendar-json.googleapis.com") || value.includes("google calendar api has not been used")) {
    return text.messages.googleApiMissing;
  }

  if (value.includes("insufficient authentication scopes")) {
    return text.messages.googleScopeMissing;
  }

  if (value.includes("google calendar is not connected")) {
    return text.messages.googleNotConnected;
  }

  if (value.includes("microsoft calendar is not connected")) {
    return text.messages.microsoftNotConnected;
  }

  if (value.includes("resend.com/domains") || value.includes("testing emails")) {
    return text.messages.resendTesting;
  }

  return error || fallback;
}

function getTemplateById(id: MeetingTemplateKey, text: CalendarCommandCenterCopy) {
  return text.meetingTemplates.find((template) => template.id === id) ?? text.meetingTemplates[0];
}

function createDefaultCalendarIntegrations(text: CalendarCommandCenterCopy): CalendarIntegrationState {
  return {
    defaultMeetingProvider: "microsoft-teams",
    defaultProvider: "microsoft",
    google: {
      accountEmail: "",
      calendarId: "",
      calendarUrl: "",
      connected: false,
      meetingConnected: false,
      meetingLinkTemplate: text.defaultMeetingLinkTemplates.google,
    },
    microsoft: {
      accountEmail: "",
      calendarId: "",
      calendarUrl: "",
      connected: false,
      meetingConnected: false,
      meetingLinkTemplate: text.defaultMeetingLinkTemplates.microsoft,
    },
    syncMode: "two_way",
  };
}

function createDefaultShareConfig(text: CalendarCommandCenterCopy): MeetingShareConfig {
  return {
    buttonLabel: text.share.buttonPlaceholder,
    height: "720",
    meetingType: "personal",
    slug: "pipeline-audit",
    theme: "light",
    utmSource: "crm",
  };
}

function createDefaultMeetingAutomation(text: CalendarCommandCenterCopy): MeetingAutomationConfig {
  const template = getTemplateById("first-call", text);

  return {
    allowCancel: true,
    allowReschedule: true,
    cancelDeadlineHours: "24",
    confirmationBody: template.confirmationBody,
    confirmationEnabled: true,
    confirmationImageMode: "host",
    confirmationSubject: template.confirmationSubject,
    confirmationTitle: template.confirmationTitle,
    postFollowUpDelayHours: "2",
    postFollowUpEnabled: false,
    reminderEnabled: true,
    reminders: [
      {
        amount: "24",
        body: template.reminderBody,
        channel: "email",
        enabled: true,
        id: "reminder_24h",
        subject: template.reminderSubject,
        title: text.defaultReminder.preparationTitle,
        unit: "hours",
      },
      {
        amount: "2",
        body: text.defaultReminder.body,
        channel: "email",
        enabled: true,
        id: "reminder_2h",
        subject: text.defaultReminder.subject,
        title: text.defaultReminder.title,
        unit: "hours",
      },
    ],
    requireCancelReason: true,
    rescheduleDeadlineHours: "12",
    templateKey: "first-call",
  };
}

function toDateTimeLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function createDefaultCalendarEventDraft(
  projects: Project[],
  users: WorkspaceUser[],
  meetingProvider: MeetingProvider,
): NewCalendarEventDraft {
  const startsAt = new Date();
  startsAt.setDate(startsAt.getDate() + 1);
  startsAt.setHours(10, 0, 0, 0);
  const endsAt = new Date(startsAt);
  endsAt.setMinutes(endsAt.getMinutes() + 45);

  return {
    contactId: "",
    endsAt: toDateTimeLocalInput(endsAt),
    leadId: "",
    location: meetingProvider === "phone" ? "Telefon" : "Extern",
    meetingProvider,
    notes: "",
    outcomeGoal: "",
    ownerUserId: users[0]?.id ?? "",
    projectId: projects[0]?.id ?? "",
    startsAt: toDateTimeLocalInput(startsAt),
    status: "geplant",
    title: "",
  };
}

export function CalendarCommandCenter({
  contacts,
  events,
  language,
  leads,
  onEventsChanged,
  projectLabel,
  projects,
  tasks,
  users,
  workspacePublicKey,
}: CalendarCommandCenterProps) {
  const text = getCalendarCommandCenterCopy(language);
  const locale = getLocale(language);
  const calendarProviderOptions = text.calendarProviders;
  const meetingProviderOptions = [
    { id: "microsoft-teams" as const, label: text.meetingProviderLabels["microsoft-teams"] },
    { id: "google-meet" as const, label: text.meetingProviderLabels["google-meet"] },
    { id: "manual-link" as const, label: text.meetingProviderLabels["manual-link"] },
    { id: "phone" as const, label: text.meetingProviderLabels.phone },
  ];
  const syncModeOptions = text.syncModes;
  const meetingShareOptions = text.shareOptions;
  const automationSteps = text.automationSteps;
  const reminderUnitOptions = text.reminderUnits;
  const reminderChannelOptions = text.reminderChannels;
  const emailImageOptions = text.emailImages;
  const meetingTemplateOptions = text.meetingTemplates;
  const defaultCalendarIntegrations = createDefaultCalendarIntegrations(text);
  const defaultShareConfig = createDefaultShareConfig(text);
  const defaultMeetingAutomation = createDefaultMeetingAutomation(text);
  const today = new Date();
  const [activeView, setActiveView] = useState<CalendarView>("today");
  const [calendarIntegrations, setCalendarIntegrations] = useState<CalendarIntegrationState>(() => {
    const connectedProvider = getCalendarProviderFromSearchParam("calendar_connected");

    if (!connectedProvider) return defaultCalendarIntegrations;

    return normalizeCalendarIntegrationSelection(
      {
        ...defaultCalendarIntegrations,
        [connectedProvider]: {
          ...defaultCalendarIntegrations[connectedProvider],
          calendarId: defaultCalendarIntegrations[connectedProvider].calendarId || "primary",
          connected: true,
          error: null,
          meetingConnected: true,
        },
      },
      connectedProvider,
    );
  });
  const [shareConfig, setShareConfig] = useState<MeetingShareConfig>(defaultShareConfig);
  const [shareMode, setShareMode] = useState<MeetingShareMode>("link");
  const [shareNotice, setShareNotice] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [eventOverlays, setEventOverlays] = useState<CalendarEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");
  const [isCreateEventOpen, setIsCreateEventOpen] = useState(false);
  const [eventSaving, setEventSaving] = useState(false);
  const [eventCreateNotice, setEventCreateNotice] = useState("");
  const [eventDraft, setEventDraft] = useState<NewCalendarEventDraft>(() =>
    createDefaultCalendarEventDraft(projects, users, defaultCalendarIntegrations.defaultMeetingProvider),
  );
  const [liveCalendarAction, setLiveCalendarAction] = useState<LiveCalendarActionState>(
    () => getInitialLiveCalendarAction(text),
  );
  const [meetingAutomation, setMeetingAutomation] = useState<MeetingAutomationConfig>(
    defaultMeetingAutomation,
  );
  const [meetingBuilderOpen, setMeetingBuilderOpen] = useState(false);
  const [automationStep, setAutomationStep] =
    useState<MeetingAutomationStep>("confirmation");
  const [selectedReminderId, setSelectedReminderId] = useState(
    defaultMeetingAutomation.reminders[0]?.id ?? "",
  );
  const [meetingSettingsStatus, setMeetingSettingsStatus] =
    useState<MeetingSettingsSaveStatus>("idle");
  const [meetingNotificationStatus, setMeetingNotificationStatus] =
    useState<MeetingNotificationStatus>("idle");
  const [meetingStatusMessage, setMeetingStatusMessage] = useState("");
  const [meetingBookingOverview, setMeetingBookingOverview] =
    useState<MeetingBookingOverviewPayload>(emptyMeetingBookingOverview);
  const [meetingBookingOverviewStatus, setMeetingBookingOverviewStatus] =
    useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [confirmingBookingId, setConfirmingBookingId] = useState("");
  const [bookingActionMessage, setBookingActionMessage] = useState("");
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>("all");
  const [retryingNotificationId, setRetryingNotificationId] = useState("");


  async function loadMeetingBookingOverview() {
    setMeetingBookingOverviewStatus("loading");

    try {
      const response = await fetch("/api/meetings/bookings?limit=50", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as MeetingBookingOverviewPayload | null;

      if (!response.ok || !payload) {
        setMeetingBookingOverviewStatus("error");
        return;
      }

      setMeetingBookingOverview(payload);
      setMeetingBookingOverviewStatus("loaded");
    } catch {
      setMeetingBookingOverviewStatus("error");
    }
  }

  async function confirmBooking(bookingId: string) {
    setConfirmingBookingId(bookingId);
    setBookingActionMessage("");

    try {
      const response = await fetch(`/api/meetings/bookings/${encodeURIComponent(bookingId)}/confirm`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        delivery?: {
          failed?: number;
          sent?: number;
        };
        error?: string | null;
        finalConfirmationQueued?: boolean;
        onlineMeetingUrl?: string | null;
        status?: string;
      };

      if (!response.ok) {
        setBookingActionMessage(
          getMeetingActionErrorMessage(payload.error, text.messages.confirmError, text),
        );
        return;
      }

      if (payload.onlineMeetingUrl && (payload.delivery?.sent ?? 0) > 0) {
        setBookingActionMessage(text.messages.confirmedSent);
      } else if (payload.onlineMeetingUrl && (payload.delivery?.failed ?? 0) > 0) {
        setBookingActionMessage(text.messages.confirmedFailedMail);
      } else if (payload.onlineMeetingUrl && payload.finalConfirmationQueued) {
        setBookingActionMessage(text.messages.confirmedQueued);
      } else {
        setBookingActionMessage(
          payload.onlineMeetingUrl
            ? text.messages.confirmedWithLink
            : payload.status === "pending"
              ? text.messages.confirmedPending
              : text.messages.confirmed,
        );
      }
      await loadMeetingBookingOverview();
    } catch {
      setBookingActionMessage(text.messages.confirmCatch);
    } finally {
      setConfirmingBookingId("");
    }
  }

  async function retryNotification(notificationId: string) {
    setRetryingNotificationId(notificationId);
    setBookingActionMessage("");

    try {
      const response = await fetch(
        `/api/meetings/notifications/${encodeURIComponent(notificationId)}/retry`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        delivery?: { failed?: number; sent?: number };
        error?: string;
      };

      if (!response.ok) {
        setBookingActionMessage(
          getMeetingActionErrorMessage(payload.error, text.messages.retryError, text),
        );
        return;
      }

      setBookingActionMessage(
        (payload.delivery?.sent ?? 0) > 0
          ? text.messages.retrySent
          : text.messages.retryQueued,
      );
      await loadMeetingBookingOverview();
    } catch {
      setBookingActionMessage(text.messages.retryCatch);
    } finally {
      setRetryingNotificationId("");
    }
  }

  useEffect(() => {
    if (!meetingBuilderOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [meetingBuilderOpen]);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `novalure.meeting.${defaultShareConfig.slug}`;

    async function loadMeetingSettings() {
      setMeetingSettingsStatus("loading");
      const connectedProvider = getCalendarProviderFromSearchParam("calendar_connected");

      try {
        await Promise.resolve();
        const cached = window.localStorage.getItem(cacheKey);

        if (cached && !cancelled) {
          try {
            const parsed = JSON.parse(cached) as MeetingSettingsApiPayload["page"];
            if (parsed?.automation) setMeetingAutomation(parsed.automation);
            if (parsed?.calendarIntegrations) {
              setCalendarIntegrations((current) =>
                mergeCalendarIntegrations(
                  parsed.calendarIntegrations ?? current,
                  current,
                  connectedProvider,
                ),
              );
            }
            if (parsed?.shareConfig) {
              setShareConfig((current) => ({
                ...current,
                ...parsed.shareConfig,
                meetingType: parsed.meetingType ?? parsed.shareConfig?.meetingType ?? current.meetingType,
              }));
            }
            setMeetingStatusMessage(text.messages.localSettingsLoaded);
          } catch {
            window.localStorage.removeItem(cacheKey);
          }
        }

        const response = await fetch(
          `/api/meetings/settings?slug=${encodeURIComponent(defaultShareConfig.slug)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => ({}))) as MeetingSettingsApiPayload;

        if (cancelled) return;

        if (response.ok && payload.page) {
          if (payload.page.automation) setMeetingAutomation(payload.page.automation);
          if (payload.page.calendarIntegrations) {
            setCalendarIntegrations((current) =>
              mergeCalendarIntegrations(
                payload.page?.calendarIntegrations ?? current,
                current,
                connectedProvider,
              ),
            );
          }
          if (payload.page.shareConfig) {
            setShareConfig((current) => ({
              ...current,
              ...payload.page?.shareConfig,
              meetingType:
                payload.page?.meetingType ??
                payload.page?.shareConfig?.meetingType ??
                current.meetingType,
            }));
          }
          window.localStorage.setItem(cacheKey, JSON.stringify(payload.page));
          setMeetingSettingsStatus("saved");
          setMeetingStatusMessage(text.messages.savedSettingsLoaded);
          return;
        }

        setMeetingSettingsStatus("idle");
      } catch {
        if (!cancelled) setMeetingSettingsStatus("idle");
      }
    }

    loadMeetingSettings();

    return () => {
      cancelled = true;
    };
  }, [defaultShareConfig.slug, text.messages.localSettingsLoaded, text.messages.savedSettingsLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function loadOAuthStatus() {
      const connectedProvider = getCalendarProviderFromSearchParam("calendar_connected");

      try {
        const response = await fetch("/api/meetings/oauth/status", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as
          | {
              google?: CalendarOAuthConnectionPayload;
              microsoft?: CalendarOAuthConnectionPayload;
            }
          | null;

        if (!response.ok || !payload || cancelled) return;

        setCalendarIntegrations((current) =>
          normalizeCalendarIntegrationSelection(
            {
              ...current,
              google: mergeOAuthConnectionStatus(current.google, payload.google),
              microsoft: mergeOAuthConnectionStatus(current.microsoft, payload.microsoft),
            },
            connectedProvider,
          ),
        );
      } catch {
        // OAuth status is optional for local previews.
      }
    }

    loadOAuthStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialBookingOverview() {
      await Promise.resolve();
      if (!cancelled) loadMeetingBookingOverview();
    }

    loadInitialBookingOverview();

    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveEvents = useMemo(() => {
    const overlayIds = new Set(eventOverlays.map((event) => event.id));
    return [...eventOverlays, ...events.filter((event) => !overlayIds.has(event.id))];
  }, [eventOverlays, events]);

  const decoratedEvents = useMemo(
    () =>
      effectiveEvents
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
    [contacts, effectiveEvents, leads, projects, users],
  );

  const todayEvents = decoratedEvents.filter((item) => isSameDay(item.event.startsAt, today));
  const prepareEvents = decoratedEvents.filter((item) => item.event.status === "vorbereiten");
  const teamsEvents = decoratedEvents.filter((item) => isOnlineMeeting(item.event));
  const followUpEvents = decoratedEvents.filter((item) => item.event.status === "nachfassen");
  const filteredEvents = decoratedEvents.filter((item) => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    const matchesView =
      (activeView === "today" && isSameDay(item.event.startsAt, today)) ||
      (activeView === "upcoming" && new Date(item.event.startsAt).getTime() >= today.getTime()) ||
      (activeView === "prepare" && item.event.status === "vorbereiten") ||
      (activeView === "teams" && isOnlineMeeting(item.event)) ||
      (activeView === "followUp" && item.event.status === "nachfassen") ||
      activeView === "bookings";
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
    { id: "bookings", label: text.bookings, count: meetingBookingOverview.metrics.totalBookings },
  ];

  const updateEventDraft = (field: keyof NewCalendarEventDraft, value: string) => {
    setEventDraft((current) => ({ ...current, [field]: value }));
  };

  const createCalendarEvent = async () => {
    if (!eventDraft.title.trim()) {
      setEventCreateNotice(text.eventTitleRequired);
      return;
    }

    setEventSaving(true);
    setEventCreateNotice("");
    try {
      const response = await fetch("/api/crm/calendar-events", {
        body: JSON.stringify({
          event: {
            contactId: eventDraft.contactId || undefined,
            endsAt: new Date(eventDraft.endsAt).toISOString(),
            leadId: eventDraft.leadId || undefined,
            location: eventDraft.location,
            meetingProvider: eventDraft.meetingProvider,
            notes: eventDraft.notes.trim() || undefined,
            outcomeGoal: eventDraft.outcomeGoal.trim(),
            ownerUserId: eventDraft.ownerUserId || undefined,
            preparation: eventDraft.notes.trim() ? [eventDraft.notes.trim()] : [],
            projectId: eventDraft.projectId || undefined,
            startsAt: new Date(eventDraft.startsAt).toISOString(),
            status: eventDraft.status,
            title: eventDraft.title.trim(),
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; event?: CalendarEvent };

      if (!response.ok || !payload.event) {
        throw new Error(payload.error ?? text.eventCreateFailed);
      }

      setEventOverlays((current) => [payload.event!, ...current.filter((event) => event.id !== payload.event!.id)]);
      setSelectedEventId(payload.event.id);
      setEventDraft(createDefaultCalendarEventDraft(projects, users, calendarIntegrations.defaultMeetingProvider));
      setIsCreateEventOpen(false);
      setEventCreateNotice(text.eventCreated);
      void onEventsChanged?.();
    } catch (error) {
      setEventCreateNotice(error instanceof Error ? error.message : text.eventCreateFailed);
    } finally {
      setEventSaving(false);
    }
  };
  const selectedProviderConfig = calendarIntegrations[calendarIntegrations.defaultProvider];
  const selectedProviderLabel = getCalendarProviderLabel(calendarIntegrations.defaultProvider, text);
  const selectedMeetingProviderLabel = getMeetingProviderLabel(
    calendarIntegrations.defaultMeetingProvider,
    text,
  );
  const hasConnectedCalendarProvider =
    calendarIntegrations.microsoft.connected || calendarIntegrations.google.connected;
  const selectedEventProvider = getEventCalendarProvider(
    selectedEvent?.event,
    calendarIntegrations.defaultProvider,
  );
  const bookingSlug = shareConfig.slug.trim() || slugify(projectLabel) || "meeting";
  const bookingPath = workspacePublicKey
    ? `/book/${encodeURIComponent(workspacePublicKey)}/${encodeURIComponent(bookingSlug)}`
    : `/book/${encodeURIComponent(bookingSlug)}`;
  const shortBookingPath = workspacePublicKey
    ? `/m/${encodeURIComponent(workspacePublicKey)}/${encodeURIComponent(bookingSlug)}`
    : `/m/${encodeURIComponent(bookingSlug)}`;
  const bookingUrl = `${publicBookingOrigin}${bookingPath}`;
  const trackingQuery = new URLSearchParams({
    calendar: calendarIntegrations.defaultProvider,
    meeting: calendarIntegrations.defaultMeetingProvider,
    theme: shareConfig.theme,
    utm_campaign: bookingSlug,
    utm_medium: "booking_link",
    utm_source: shareConfig.utmSource.trim() || "crm",
  });
  const trackedBookingUrl = `${bookingUrl}?${trackingQuery.toString()}`;
  const shortBookingUrl = `${publicBookingOrigin}${shortBookingPath}?${trackingQuery.toString()}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    shortBookingUrl,
  )}`;
  const embedCode = `<iframe src="${trackedBookingUrl}" title="${shareConfig.buttonLabel}" style="width:100%;min-height:${shareConfig.height}px;border:0;border-radius:12px;overflow:hidden" loading="lazy"></iframe>`;
  const buttonCode = `<a href="${trackedBookingUrl}" style="display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:#0f172a;color:#fff;padding:12px 18px;text-decoration:none;font-weight:700" target="_blank" rel="noreferrer">${shareConfig.buttonLabel}</a>`;
  const messageTemplate = text.share.messageTemplate(trackedBookingUrl);
  const qrPayload = text.share.qrPayload(shortBookingUrl, qrImageUrl);
  const shareArtifacts: Record<MeetingShareMode, string> = {
    button: buttonCode,
    embed: embedCode,
    link: trackedBookingUrl,
    message: messageTemplate,
    qr: qrPayload,
  };
  const selectedShareOption =
    meetingShareOptions.find((option) => option.id === shareMode) ?? meetingShareOptions[0];
  const selectedReminder =
    meetingAutomation.reminders.find((reminder) => reminder.id === selectedReminderId) ??
    meetingAutomation.reminders[0];
  const selectedTemplate = getTemplateById(meetingAutomation.templateKey, text);
  const contactName = selectedEvent?.contact?.name ?? "Mira Klein";
  const contactFirstName = contactName.split(" ")[0] ?? contactName;
  const meetingTokenValues: Record<string, string> = {
    "{{contact.email}}": selectedEvent?.contact?.email ?? "kontakt@unternehmen.com",
    "{{contact.firstName}}": contactFirstName,
    "{{host.name}}": selectedEvent?.owner?.name ?? users[0]?.name ?? "Novalure",
    "{{meeting.cancelLink}}": `${bookingUrl}/cancel`,
    "{{meeting.date}}": selectedEvent ? formatDateTime(selectedEvent.event.startsAt, locale) : "20.05.2026",
    "{{meeting.link}}": trackedBookingUrl,
    "{{meeting.location}}": selectedEvent?.event.location ?? selectedMeetingProviderLabel,
    "{{meeting.rescheduleLink}}": `${bookingUrl}/reschedule`,
    "{{meeting.time}}": selectedEvent ? formatTime(selectedEvent.event.startsAt, locale) : "10:00",
    "{{meeting.title}}": selectedEvent?.event.title ?? "Pipeline Audit",
  };
  const previewDraft: EmailDraftPreview =
    automationStep === "reminders" && selectedReminder
      ? {
          body: selectedReminder.body,
          subject: selectedReminder.subject,
          title: selectedReminder.title,
        }
      : {
          body: meetingAutomation.confirmationBody,
          subject: meetingAutomation.confirmationSubject,
          title: meetingAutomation.confirmationTitle,
        };
  const activeReminderCount = meetingAutomation.reminders.filter((reminder) => reminder.enabled).length;
  const filteredNotifications = meetingBookingOverview.notifications.filter((notification) => {
    if (notificationFilter === "all") return true;
    return notification.status === notificationFilter;
  });

  const copyShareArtifact = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setShareNotice(text.share.copied(label));
    } catch {
      setShareNotice(text.share.readyToCopy(label));
    }
  };

  const getMeetingSettingsPayload = () => ({
    automation: meetingAutomation,
    calendarIntegrations,
    meetingType: shareConfig.meetingType,
    shareConfig,
    slug: bookingSlug,
    title: selectedEvent?.event.title ?? shareConfig.buttonLabel ?? "Meeting",
  });

  const saveMeetingSettings = async (closeAfterSave = false) => {
    const page = getMeetingSettingsPayload();
    const cacheKey = `novalure.meeting.${page.slug}`;

    setMeetingSettingsStatus("saving");
    setMeetingStatusMessage(text.messages.savingSettings);
    window.localStorage.setItem(cacheKey, JSON.stringify(page));
    window.localStorage.setItem(`novalure.meeting.${defaultShareConfig.slug}`, JSON.stringify(page));

    try {
      const response = await fetch("/api/meetings/settings", {
        body: JSON.stringify({ page }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        persisted?: boolean;
      };

      if (!response.ok || !result.persisted) {
        setMeetingSettingsStatus("error");
        setMeetingStatusMessage(
          result.error
            ? text.messages.localSavedDbWaiting(result.error)
            : text.messages.localSavedDbUnconfirmed,
        );
        return;
      }

      setMeetingSettingsStatus("saved");
      setMeetingStatusMessage(text.messages.settingsSaved);
      if (closeAfterSave) setMeetingBuilderOpen(false);
    } catch {
      setMeetingSettingsStatus("error");
      setMeetingStatusMessage(text.messages.localSavedApiUnavailable);
    }
  };

  const sendMeetingTestNotification = async () => {
    const to = selectedEvent?.contact?.email ?? users[0]?.email ?? "";

    if (!to) {
      setMeetingNotificationStatus("error");
      setMeetingStatusMessage(text.messages.noTestEmail);
      return;
    }

    setMeetingNotificationStatus("sending");
    setMeetingStatusMessage(text.messages.preparingTestMail(to));

    try {
      const response = await fetch("/api/meetings/notifications", {
        body: JSON.stringify({
          body: previewDraft.body,
          idempotencyKey: `meeting:${bookingSlug}:${automationStep}:${previewDraft.subject}:${to}`,
          kind: automationStep === "reminders" ? "reminder" : "confirmation",
          subject: previewDraft.subject,
          title: previewDraft.title,
          to,
          tokens: meetingTokenValues,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => ({}))) as {
        send?: { status?: string | null };
      };
      const status = result.send?.status;

      if (!response.ok || status === "failed") {
        setMeetingNotificationStatus("error");
        setMeetingStatusMessage(text.messages.testMailError);
        return;
      }

      setMeetingNotificationStatus(status === "sent" ? "sent" : "queued");
      setMeetingStatusMessage(
        status === "sent"
          ? text.messages.testMailSent(to)
          : text.messages.testMailQueued,
      );
    } catch {
      setMeetingNotificationStatus("error");
      setMeetingStatusMessage(text.messages.testMailApiUnavailable);
    }
  };

  const updateMeetingAutomation = <Field extends keyof MeetingAutomationConfig>(
    field: Field,
    value: MeetingAutomationConfig[Field],
  ) => {
    setMeetingAutomation((current) => ({ ...current, [field]: value }));
  };

  const updateReminder = <Field extends keyof MeetingReminderConfig>(
    reminderId: string,
    field: Field,
    value: MeetingReminderConfig[Field],
  ) => {
    setMeetingAutomation((current) => ({
      ...current,
      reminders: current.reminders.map((reminder) =>
        reminder.id === reminderId ? { ...reminder, [field]: value } : reminder,
      ),
    }));
  };

  const addReminder = () => {
    const id = `reminder_${Date.now()}`;
    setMeetingAutomation((current) => ({
      ...current,
      reminderEnabled: true,
      reminders: [
        ...current.reminders,
        {
          amount: "1",
          body: text.newReminder.body,
          channel: "email",
          enabled: true,
          id,
          subject: text.newReminder.subject,
          title: text.newReminder.title,
          unit: "hours",
        },
      ],
    }));
    setSelectedReminderId(id);
    setAutomationStep("reminders");
  };

  const duplicateReminder = (reminder: MeetingReminderConfig) => {
    const id = `reminder_${Date.now()}`;
    setMeetingAutomation((current) => ({
      ...current,
      reminders: [
        ...current.reminders,
        { ...reminder, id, title: `${reminder.title} ${text.newReminder.copySuffix}` },
      ],
    }));
    setSelectedReminderId(id);
  };

  const removeReminder = (reminderId: string) => {
    setMeetingAutomation((current) => {
      const reminders = current.reminders.filter((reminder) => reminder.id !== reminderId);
      return {
        ...current,
        reminders: reminders.length ? reminders : current.reminders,
      };
    });
    const fallback = meetingAutomation.reminders.find((reminder) => reminder.id !== reminderId);
    if (fallback) setSelectedReminderId(fallback.id);
  };

  const applyTemplate = (templateKey: MeetingTemplateKey) => {
    const template = getTemplateById(templateKey, text);
    setMeetingAutomation((current) => ({
      ...current,
      confirmationBody: template.confirmationBody,
      confirmationSubject: template.confirmationSubject,
      confirmationTitle: template.confirmationTitle,
      reminders: current.reminders.map((reminder, index) =>
        index === 0
          ? {
              ...reminder,
              body: template.reminderBody,
              subject: template.reminderSubject,
              title: `${template.label} ${text.notificationKindLabels.reminder}`,
            }
          : reminder,
      ),
      templateKey,
    }));
  };

  const appendTokenToConfirmation = (token: string) => {
    setMeetingAutomation((current) => ({
      ...current,
      confirmationBody: `${current.confirmationBody}${current.confirmationBody ? " " : ""}${token}`,
    }));
  };

  const appendTokenToReminder = (token: string) => {
    if (!selectedReminder) return;
    updateReminder(
      selectedReminder.id,
      "body",
      `${selectedReminder.body}${selectedReminder.body ? " " : ""}${token}`,
    );
  };

  const updateProviderConfig = (
    provider: CalendarProvider,
    field: keyof CalendarConnectionConfig,
    value: string | boolean,
  ) => {
    setCalendarIntegrations((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        [field]: value,
      },
    }));
  };

  const connectCalendarProvider = (provider: CalendarProvider) => {
    const option = calendarProviderOptions.find((item) => item.id === provider);

    setCalendarIntegrations((current) => ({
      ...current,
      defaultMeetingProvider: option?.meetingProvider ?? current.defaultMeetingProvider,
      defaultProvider: provider,
      [provider]: {
        ...current[provider],
        calendarId:
          current[provider].calendarId ||
          current[provider].calendarUrl ||
          `${provider}-primary-calendar`,
        connected: true,
      },
    }));
    setLiveCalendarAction({
      detail: text.messages.providerOAuthOpening(getCalendarProviderLabel(provider, text)),
      status: "running",
    });

    const returnTo = `${window.location.pathname}${window.location.search || ""}${window.location.hash || "#calendar"}`;
    window.location.assign(
      `/api/meetings/oauth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`,
    );
  };

  const connectMeetingProvider = (provider: CalendarProvider) => {
    const meetingProvider =
      provider === "google" ? ("google-meet" as const) : ("microsoft-teams" as const);

    setCalendarIntegrations((current) => ({
      ...current,
      defaultMeetingProvider: meetingProvider,
      defaultProvider: provider,
      [provider]: {
        ...current[provider],
        connected: true,
        meetingConnected: true,
      },
    }));
    setLiveCalendarAction({
      detail: text.messages.meetingProviderConnecting(
        getMeetingProviderLabel(meetingProvider, text),
        getCalendarProviderLabel(provider, text),
      ),
      status: "running",
    });

    const returnTo = `${window.location.pathname}${window.location.search || ""}${window.location.hash || "#calendar"}`;
    window.location.assign(
      `/api/meetings/oauth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`,
    );
  };

  const disconnectCalendarProvider = async (provider: CalendarProvider) => {
    const providerLabel = getCalendarProviderLabel(provider, text);

    setLiveCalendarAction({
      detail: text.messages.providerDisconnecting(providerLabel),
      status: "running",
    });

    try {
      const response = await fetch(`/api/meetings/oauth/${provider}/disconnect`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; reason?: string | null }
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.reason || "disconnect_failed");
      }

      setCalendarIntegrations((current) => ({
        ...current,
        [provider]: {
          ...current[provider],
          connected: false,
          meetingConnected: false,
        },
      }));
      setLiveCalendarAction({
        detail: text.messages.providerDisconnected(providerLabel),
        status: "success",
      });
    } catch (error) {
      setLiveCalendarAction({
        detail:
          error instanceof Error
            ? error.message
            : text.messages.providerDisconnectFailed(providerLabel),
        status: "error",
      });
    }
  };

  const liveCalendarMessage =
    liveCalendarAction.detail ??
    (liveCalendarAction.status === "success"
      ? text.liveSyncSuccess
      : liveCalendarAction.status === "error"
        ? text.liveSyncError
        : liveCalendarAction.status === "running"
          ? text.liveSyncRunning
          : selectedProviderConfig.connected
            ? text.liveSyncIdle
            : text.calendarSetup.missingConnection);

  const syncLiveTeamsMeeting = async () => {
    setLiveCalendarAction({ status: "running" });

    try {
      if (!selectedEvent) {
        throw new Error(text.noEvents);
      }

      if (!selectedProviderConfig.connected) {
        throw new Error(text.calendarSetup.missingConnection);
      }

      const body = [
        `<p><strong>${escapeHtml(text.project)}:</strong> ${escapeHtml(selectedEvent.project?.name ?? projectLabel)}</p>`,
        `<p><strong>${escapeHtml(text.contact)}:</strong> ${escapeHtml(selectedEvent.contact?.name ?? text.noContact)}</p>`,
        `<p><strong>${escapeHtml(text.leadContext)}:</strong> ${escapeHtml(selectedEvent.lead?.intent ?? text.noLead)}</p>`,
        `<p><strong>${escapeHtml(text.outcomeGoal)}:</strong> ${escapeHtml(selectedEvent.event.outcomeGoal)}</p>`,
        `<p><strong>${escapeHtml(text.preparation)}:</strong> ${escapeHtml(selectedEvent.event.preparation.join(", "))}</p>`,
      ].join("");
      const attendees = selectedEvent.contact?.email ? [selectedEvent.contact.email] : [];

      const response = await fetch(
        calendarIntegrations.defaultProvider === "google"
          ? "/api/calendar/google"
          : "/api/calendar/microsoft",
        {
        body: JSON.stringify({
          attendees,
          body,
          calendarEventId: selectedEvent.event.id,
          createOnlineMeeting:
            calendarIntegrations.defaultMeetingProvider === "microsoft-teams" ||
            calendarIntegrations.defaultMeetingProvider === "google-meet",
          endsAt: selectedEvent.event.endsAt,
          location:
            calendarIntegrations.defaultMeetingProvider === "microsoft-teams"
              ? "Microsoft Teams"
              : calendarIntegrations.defaultMeetingProvider === "google-meet"
                ? "Google Meet"
                : selectedEvent.event.location,
          startsAt: selectedEvent.event.startsAt,
          subject: selectedEvent.event.title,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        },
      );
      const data = (await response.json()) as LiveCalendarResponse;

      if (!response.ok || !data.ok) {
        throw new Error(data.error || text.liveSyncError);
      }

      setLiveCalendarAction({
        detail: text.liveSyncSuccess.replace("{{title}}", selectedEvent.event.title),
        status: "success",
        url: data.onlineMeetingUrl || data.webLink || null,
      });
    } catch (error) {
      setLiveCalendarAction({
        detail: error instanceof Error ? error.message : text.liveSyncError,
        status: "error",
      });
    }
  };

  if (meetingBuilderOpen) {
    return (
      <section className="fixed inset-0 z-50 flex min-h-0 flex-col bg-[#eef7ff] text-slate-950">
        <header className="shrink-0 border-b border-blue-100 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <button
                className="shrink-0 rounded-md border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-blue-50"
                onClick={() => setMeetingBuilderOpen(false)}
                type="button"
              >
                {text.builder.back}
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
                  {text.builder.eyebrow}
                </p>
                <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">
                  {text.builder.title}
                </h3>
                <p className="mt-1 break-words text-xs text-stone-600">
                  {bookingSlug} · {selectedProviderLabel} · {selectedMeetingProviderLabel}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-blue-50"
                href={trackedBookingUrl}
                rel="noreferrer"
                target="_blank"
              >
                {text.builder.openBookingPage}
              </a>
              <button
                className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={meetingNotificationStatus === "sending"}
                onClick={sendMeetingTestNotification}
                type="button"
              >
                {meetingNotificationStatus === "sending" ? text.builder.sendingTest : text.builder.sendTest}
              </button>
              <button
                className="rounded-md bg-blue-500 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-blue-300"
                disabled={meetingSettingsStatus === "saving"}
                onClick={() => saveMeetingSettings(true)}
                type="button"
              >
                {meetingSettingsStatus === "saving" ? text.builder.saving : text.builder.save}
              </button>
            </div>
          </div>
          {meetingStatusMessage ? (
            <p
              className={`mt-3 rounded-md border px-3 py-2 text-sm font-semibold ${
                meetingSettingsStatus === "error" || meetingNotificationStatus === "error"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-emerald-200 bg-emerald-50 text-emerald-900"
              }`}
            >
              {meetingStatusMessage}
            </p>
          ) : null}
        </header>

        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3 xl:grid-cols-[280px_minmax(0,1fr)_380px]">
          <aside className="grid min-h-0 content-start gap-4 overflow-y-auto rounded-lg border border-blue-100 bg-white p-4">
            <div>
              <p className="text-sm font-semibold">{text.builder.setupSteps}</p>
              <div className="mt-3 grid gap-2">
                {automationSteps.map((step) => (
                  <button
                    className={`rounded-md border px-3 py-3 text-left ${
                      automationStep === step.id
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-blue-100 bg-blue-50 text-slate-950 hover:border-blue-200 hover:bg-white"
                    }`}
                    key={step.id}
                    onClick={() => setAutomationStep(step.id)}
                    type="button"
                  >
                    <span className="block text-sm font-semibold">{step.label}</span>
                    <span
                      className={`mt-1 block text-xs ${
                        automationStep === step.id ? "text-slate-200" : "text-stone-600"
                      }`}
                    >
                      {step.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                {text.builder.activeTimeline}
              </p>
              <div className="mt-3 grid gap-2 text-xs">
                <div className="rounded-md bg-white px-3 py-2">
                  <p className="font-semibold">{text.builder.immediatelyAfterBooking}</p>
                  <p className="text-stone-600">
                    {meetingAutomation.confirmationEnabled
                      ? text.builder.confirmationEmail
                      : text.builder.disabled}
                  </p>
                </div>
                {meetingAutomation.reminders.map((reminder) => (
                  <button
                    className={`rounded-md px-3 py-2 text-left ${
                      selectedReminder?.id === reminder.id
                        ? "bg-slate-950 text-white"
                        : "bg-white text-slate-950"
                    }`}
                    key={reminder.id}
                    onClick={() => {
                      setSelectedReminderId(reminder.id);
                      setAutomationStep("reminders");
                    }}
                    type="button"
                  >
                    <p className="font-semibold">{formatReminderSchedule(reminder, text)}</p>
                    <p className={selectedReminder?.id === reminder.id ? "text-slate-200" : "text-stone-600"}>
                      {reminder.enabled
                        ? reminderChannelOptions.find((option) => option.id === reminder.channel)?.label ?? reminder.channel
                        : text.builder.disabled}{" "}
                      · {reminder.title}
                    </p>
                  </button>
                ))}
                {meetingAutomation.postFollowUpEnabled ? (
                  <div className="rounded-md bg-white px-3 py-2">
                    <p className="font-semibold">
                      {text.builder.hoursAfter(meetingAutomation.postFollowUpDelayHours)}
                    </p>
                    <p className="text-stone-600">{text.builder.followUpEmail}</p>
                  </div>
                ) : null}
              </div>
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto rounded-lg border border-blue-100 bg-white p-5">
            {automationStep === "overview" ? (
              <div className="grid gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {text.builder.overviewEyebrow}
                  </p>
                  <h4 className="mt-1 text-2xl font-semibold">{text.builder.overviewTitle}</h4>
                  <p className="mt-2 max-w-3xl text-sm text-stone-600">
                    {text.builder.overviewDescription}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {[
                    [
                      text.builder.confirmationMetric,
                      meetingAutomation.confirmationEnabled ? text.builder.active : text.builder.inactive,
                    ],
                    [text.builder.remindersMetric, `${activeReminderCount} ${text.builder.active}`],
                    [
                      text.builder.selfServiceMetric,
                      `${meetingAutomation.allowReschedule ? text.builder.reschedule : ""}${
                        meetingAutomation.allowReschedule && meetingAutomation.allowCancel ? " + " : ""
                      }${meetingAutomation.allowCancel ? text.builder.cancel : ""}` || text.builder.inactive,
                    ],
                  ].map(([label, value]) => (
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-4" key={label}>
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                        {label}
                      </p>
                      <p className="mt-2 text-lg font-semibold">{value}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <p className="text-sm font-semibold">{text.builder.personalizationTokens}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {meetingTokenOptions.map((token) => (
                      <span className="rounded-md border border-stone-200 bg-white px-2 py-1 font-mono text-xs" key={token}>
                        {token}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {automationStep === "confirmation" ? (
              <div className="grid gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                      {text.builder.confirmationEmail}
                    </p>
                    <h4 className="mt-1 text-2xl font-semibold">{text.builder.confirmationTitle}</h4>
                    <p className="mt-2 max-w-3xl text-sm text-stone-600">
                      {text.builder.confirmationDescription}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm font-semibold">
                    <input
                      checked={meetingAutomation.confirmationEnabled}
                      onChange={(event) =>
                        updateMeetingAutomation("confirmationEnabled", event.target.checked)
                      }
                      type="checkbox"
                    />
                    {text.builder.active}
                  </label>
                </div>
                <div className="grid gap-3">
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.builder.subject}
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                      onChange={(event) =>
                        updateMeetingAutomation("confirmationSubject", event.target.value)
                      }
                      value={meetingAutomation.confirmationSubject}
                    />
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.builder.emailTitle}
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                      onChange={(event) =>
                        updateMeetingAutomation("confirmationTitle", event.target.value)
                      }
                      value={meetingAutomation.confirmationTitle}
                    />
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.builder.image}
                    <select
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                      onChange={(event) =>
                        updateMeetingAutomation(
                          "confirmationImageMode",
                          event.target.value as EmailImageMode,
                        )
                      }
                      value={meetingAutomation.confirmationImageMode}
                    >
                      {emailImageOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.builder.body}
                    <textarea
                      className="min-h-64 rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal"
                      onChange={(event) =>
                        updateMeetingAutomation("confirmationBody", event.target.value)
                      }
                      value={meetingAutomation.confirmationBody}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {meetingTokenOptions.map((token) => (
                      <button
                        className="rounded-md border border-blue-100 bg-blue-50 px-2 py-1 font-mono text-xs font-semibold text-blue-950 hover:bg-white"
                        key={token}
                        onClick={() => appendTokenToConfirmation(token)}
                        type="button"
                      >
                        {token}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {automationStep === "reminders" ? (
              <div className="grid gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                      {text.builder.remindersMetric}
                    </p>
                    <h4 className="mt-1 text-2xl font-semibold">{text.builder.remindersTitle}</h4>
                    <p className="mt-2 max-w-3xl text-sm text-stone-600">
                      {text.builder.remindersDescription}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm font-semibold">
                      <input
                        checked={meetingAutomation.reminderEnabled}
                        onChange={(event) =>
                          updateMeetingAutomation("reminderEnabled", event.target.checked)
                        }
                        type="checkbox"
                      />
                      {text.builder.active}
                    </label>
                    <button
                      className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
                      onClick={addReminder}
                      type="button"
                    >
                      {text.builder.addReminder}
                    </button>
                  </div>
                </div>

                {meetingAutomation.reminders.length > 3 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                    {text.builder.reminderWarning}
                  </p>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
                  <div className="grid content-start gap-2">
                    {meetingAutomation.reminders.map((reminder) => (
                      <button
                        className={`rounded-md border px-3 py-3 text-left ${
                          selectedReminder?.id === reminder.id
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-stone-200 bg-stone-50 text-slate-950 hover:bg-white"
                        }`}
                        key={reminder.id}
                        onClick={() => setSelectedReminderId(reminder.id)}
                        type="button"
                      >
                        <span className="block text-sm font-semibold">{formatReminderSchedule(reminder, text)}</span>
                        <span className="mt-1 block text-xs opacity-75">{reminder.title}</span>
                      </button>
                    ))}
                  </div>

                  {selectedReminder ? (
                    <div className="grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4">
                      <div className="grid gap-3 md:grid-cols-[120px_1fr_1fr]">
                        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                          {text.builder.when}
                          <input
                            className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                            onChange={(event) =>
                              updateReminder(selectedReminder.id, "amount", event.target.value)
                            }
                            type="number"
                            value={selectedReminder.amount}
                          />
                        </label>
                        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                          {text.builder.unit}
                          <select
                            className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                            onChange={(event) =>
                              updateReminder(
                                selectedReminder.id,
                                "unit",
                                event.target.value as ReminderUnit,
                              )
                            }
                            value={selectedReminder.unit}
                          >
                            {reminderUnitOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                          {text.builder.channel}
                          <select
                            className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                            onChange={(event) =>
                              updateReminder(
                                selectedReminder.id,
                                "channel",
                                event.target.value as ReminderChannel,
                              )
                            }
                            value={selectedReminder.channel}
                          >
                            {reminderChannelOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <label className="flex items-center gap-2 text-sm font-semibold">
                        <input
                          checked={selectedReminder.enabled}
                          onChange={(event) =>
                            updateReminder(selectedReminder.id, "enabled", event.target.checked)
                          }
                          type="checkbox"
                        />
                        {text.builder.sendReminder}
                      </label>
                      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {text.builder.subject}
                        <input
                          className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                          onChange={(event) =>
                            updateReminder(selectedReminder.id, "subject", event.target.value)
                          }
                          value={selectedReminder.subject}
                        />
                      </label>
                      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {text.builder.emailTitle}
                        <input
                          className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold normal-case tracking-normal"
                          onChange={(event) =>
                            updateReminder(selectedReminder.id, "title", event.target.value)
                          }
                          value={selectedReminder.title}
                        />
                      </label>
                      <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {text.builder.body}
                        <textarea
                          className="min-h-52 rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal"
                          onChange={(event) =>
                            updateReminder(selectedReminder.id, "body", event.target.value)
                          }
                          value={selectedReminder.body}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {meetingTokenOptions.map((token) => (
                          <button
                            className="rounded-md border border-blue-100 bg-blue-50 px-2 py-1 font-mono text-xs font-semibold text-blue-950 hover:bg-white"
                            key={token}
                            onClick={() => appendTokenToReminder(token)}
                            type="button"
                          >
                            {token}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold"
                          onClick={() => duplicateReminder(selectedReminder)}
                          type="button"
                        >
                          {text.builder.duplicate}
                        </button>
                        <button
                          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900"
                          onClick={() => removeReminder(selectedReminder.id)}
                          type="button"
                        >
                          {text.builder.delete}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {automationStep === "reschedule" ? (
              <div className="grid gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {text.builder.reschedule} & {text.builder.cancel}
                  </p>
                  <h4 className="mt-1 text-2xl font-semibold">{text.builder.rescheduleCancelTitle}</h4>
                  <p className="mt-2 max-w-3xl text-sm text-stone-600">
                    {text.builder.rescheduleCancelDescription}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-2 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm font-semibold">
                    <span className="flex items-center gap-2">
                      <input
                        checked={meetingAutomation.allowReschedule}
                        onChange={(event) =>
                          updateMeetingAutomation("allowReschedule", event.target.checked)
                        }
                        type="checkbox"
                      />
                      {text.builder.allowReschedule}
                    </span>
                    <span className="text-xs font-normal text-stone-600">{text.builder.deadlineHours}</span>
                    <input
                      className="rounded-md border border-stone-300 bg-white px-3 py-2"
                      onChange={(event) =>
                        updateMeetingAutomation("rescheduleDeadlineHours", event.target.value)
                      }
                      type="number"
                      value={meetingAutomation.rescheduleDeadlineHours}
                    />
                  </label>
                  <label className="grid gap-2 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm font-semibold">
                    <span className="flex items-center gap-2">
                      <input
                        checked={meetingAutomation.allowCancel}
                        onChange={(event) =>
                          updateMeetingAutomation("allowCancel", event.target.checked)
                        }
                        type="checkbox"
                      />
                      {text.builder.allowCancel}
                    </span>
                    <span className="text-xs font-normal text-stone-600">{text.builder.deadlineHours}</span>
                    <input
                      className="rounded-md border border-stone-300 bg-white px-3 py-2"
                      onChange={(event) =>
                        updateMeetingAutomation("cancelDeadlineHours", event.target.value)
                      }
                      type="number"
                      value={meetingAutomation.cancelDeadlineHours}
                    />
                  </label>
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm font-semibold">
                  <input
                    checked={meetingAutomation.requireCancelReason}
                    onChange={(event) =>
                      updateMeetingAutomation("requireCancelReason", event.target.checked)
                    }
                    type="checkbox"
                  />
                  {text.builder.requireCancelReason}
                </label>
                <label className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm font-semibold">
                  <span className="flex items-center gap-2">
                    <input
                      checked={meetingAutomation.postFollowUpEnabled}
                      onChange={(event) =>
                        updateMeetingAutomation("postFollowUpEnabled", event.target.checked)
                      }
                      type="checkbox"
                    />
                    {text.builder.prepareFollowUp}
                  </span>
                  <span className="text-xs font-normal text-stone-600">{text.builder.hoursAfterAppointment}</span>
                  <input
                    className="max-w-40 rounded-md border border-stone-300 bg-white px-3 py-2"
                    onChange={(event) =>
                      updateMeetingAutomation("postFollowUpDelayHours", event.target.value)
                    }
                    type="number"
                    value={meetingAutomation.postFollowUpDelayHours}
                  />
                </label>
              </div>
            ) : null}

            {automationStep === "templates" ? (
              <div className="grid gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {text.builder.templates}
                  </p>
                  <h4 className="mt-1 text-2xl font-semibold">{text.builder.templatesTitle}</h4>
                  <p className="mt-2 max-w-3xl text-sm text-stone-600">
                    {text.builder.templatesDescription}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {meetingTemplateOptions.map((template) => (
                    <button
                      className={`rounded-lg border p-4 text-left ${
                        meetingAutomation.templateKey === template.id
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-stone-50 text-slate-950 hover:bg-white"
                      }`}
                      key={template.id}
                      onClick={() => applyTemplate(template.id)}
                      type="button"
                    >
                      <span className="block text-base font-semibold">{template.label}</span>
                      <span className="mt-2 block text-xs opacity-75">{template.confirmationSubject}</span>
                    </button>
                  ))}
                </div>
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                  <p className="text-sm font-semibold">{text.builder.activeTemplate}</p>
                  <p className="mt-1 text-sm text-blue-950">{selectedTemplate.label}</p>
                </div>
              </div>
            ) : null}
          </main>

          <aside className="grid min-h-0 content-start gap-4 overflow-y-auto rounded-lg border border-blue-100 bg-white p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                {text.builder.preview}
              </p>
              <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.builder.subject}
                </p>
                <p className="mt-1 break-words text-sm font-semibold">
                  {resolveMeetingTokens(previewDraft.subject, meetingTokenValues)}
                </p>
                <div className="mt-4 rounded-lg bg-white p-4 shadow-sm">
                  {meetingAutomation.confirmationImageMode !== "none" ? (
                    <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-blue-100 text-lg font-semibold text-blue-900">
                      {meetingAutomation.confirmationImageMode === "company" ? "N" : "H"}
                    </div>
                  ) : null}
                  <h5 className="break-words text-lg font-semibold">
                    {resolveMeetingTokens(previewDraft.title, meetingTokenValues)}
                  </h5>
                  <p className="mt-3 whitespace-pre-line break-words text-sm leading-6 text-stone-700">
                    {resolveMeetingTokens(previewDraft.body, meetingTokenValues)}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <a
                      className="rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white"
                      href={trackedBookingUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {text.builder.openMeeting}
                    </a>
                    {meetingAutomation.allowReschedule ? (
                      <a
                        className="rounded-md border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-slate-950"
                        href={`${bookingUrl}/reschedule`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {text.builder.reschedule}
                      </a>
                    ) : null}
                    {meetingAutomation.allowCancel ? (
                      <a
                        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-900"
                        href={`${bookingUrl}/cancel`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {text.builder.cancel}
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
              <p className="text-sm font-semibold">{text.builder.rules}</p>
              <div className="mt-3 grid gap-2 text-xs text-stone-600">
                <span>{text.builder.rescheduleUntil(meetingAutomation.rescheduleDeadlineHours)}</span>
                <span>{text.builder.cancelUntil(meetingAutomation.cancelDeadlineHours)}</span>
                <span>
                  {meetingAutomation.requireCancelReason
                    ? text.builder.cancelReasonRequired
                    : text.builder.cancelWithoutReason}
                </span>
                <span>{text.builder.deliveryNote}</span>
              </div>
            </div>
          </aside>
        </div>
      </section>
    );
  }

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
          <div className="grid min-w-0 grid-cols-2 gap-2 text-sm sm:min-w-[520px] md:grid-cols-4 xl:min-w-[620px]">
            {[
              { label: text.todayCount, value: todayEvents.length },
              { label: text.prepCount, value: prepareEvents.length },
              { label: text.teamsCount, value: teamsEvents.length },
              { label: text.followUpCount, value: followUpEvents.length },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 p-3" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="crm-kpi-label text-xs leading-4 text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => setIsCreateEventOpen((current) => !current)}
            type="button"
          >
            {isCreateEventOpen ? text.cancel : text.newEvent}
          </button>
        </div>
        {isCreateEventOpen ? (
          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="min-w-0">
              <h4 className="text-lg font-semibold text-slate-950">{text.createEventTitle}</h4>
              <p className="mt-1 break-words text-sm text-stone-600">{text.createEventDescription}</p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                {text.eventTitleField}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("title", event.target.value)}
                  value={eventDraft.title}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.start}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("startsAt", event.target.value)}
                  type="datetime-local"
                  value={eventDraft.startsAt}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.end}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("endsAt", event.target.value)}
                  type="datetime-local"
                  value={eventDraft.endsAt}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.project}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("projectId", event.target.value)}
                  value={eventDraft.projectId}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.owner}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("ownerUserId", event.target.value)}
                  value={eventDraft.ownerUserId}
                >
                  <option value="">{text.noOwner}</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.contact}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("contactId", event.target.value)}
                  value={eventDraft.contactId}
                >
                  <option value="">{text.noContact}</option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.leadContext}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("leadId", event.target.value)}
                  value={eventDraft.leadId}
                >
                  <option value="">{text.noLead}</option>
                  {leads.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {getCrmSystemTextLabel(lead.intent, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.meetingProvider}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("meetingProvider", event.target.value as MeetingProvider)}
                  value={eventDraft.meetingProvider}
                >
                  {meetingProviderOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.location}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("location", event.target.value as CalendarEvent["location"])}
                  value={eventDraft.location}
                >
                  {(["Teams", "Google Meet", "Vor Ort", "Telefon", "Extern"] as CalendarEvent["location"][]).map((location) => (
                    <option key={location} value={location}>
                      {location}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.status}
                <select
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("status", event.target.value as CalendarEvent["status"])}
                  value={eventDraft.status}
                >
                  {(["geplant", "vorbereiten", "bestätigt", "nachfassen"] as CalendarEvent["status"][]).map((status) => (
                    <option key={status} value={status}>
                      {text.statusLabels[status]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.outcomeGoal}
                <input
                  className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("outcomeGoal", event.target.value)}
                  value={eventDraft.outcomeGoal}
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 md:col-span-2">
                {text.notes}
                <textarea
                  className="mt-2 min-h-24 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
                  onChange={(event) => updateEventDraft("notes", event.target.value)}
                  value={eventDraft.notes}
                />
              </label>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={eventSaving}
                onClick={() => void createCalendarEvent()}
                type="button"
              >
                {eventSaving ? text.savingEvent : text.saveEvent}
              </button>
              <button
                className="rounded-md border border-stone-300 px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-white"
                onClick={() => {
                  setEventDraft(createDefaultCalendarEventDraft(projects, users, calendarIntegrations.defaultMeetingProvider));
                  setIsCreateEventOpen(false);
                }}
                type="button"
              >
                {text.cancel}
              </button>
            </div>
          </div>
        ) : null}
        {eventCreateNotice ? (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
            {eventCreateNotice}
          </p>
        ) : null}
      </article>

      <article className="rounded-lg border border-blue-100 bg-blue-50 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
              {text.setup.eyebrow}
            </p>
            <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
              {text.setup.title}
            </h4>
            <p className="mt-2 max-w-3xl break-words text-sm text-blue-950">
              {text.setup.description}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[520px]">
            {[
              [
                text.builder.confirmationMetric,
                meetingAutomation.confirmationEnabled ? text.builder.active : text.builder.inactive,
              ],
              [text.builder.remindersMetric, `${activeReminderCount} ${text.builder.active}`],
              [
                text.builder.selfServiceMetric,
                `${meetingAutomation.allowReschedule ? text.builder.reschedule : ""}${
                  meetingAutomation.allowReschedule && meetingAutomation.allowCancel ? " + " : ""
                }${meetingAutomation.allowCancel ? text.builder.cancel : ""}` || text.builder.inactive,
              ],
            ].map(([label, value]) => (
              <div className="rounded-md bg-white px-3 py-2 text-sm" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {label}
                </p>
                <p className="mt-1 break-words font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => setMeetingBuilderOpen(true)}
            type="button"
          >
              {text.setup.editLarge}
          </button>
          <button
            className="rounded-md border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-950 hover:bg-blue-100"
            onClick={() => {
              setAutomationStep("reminders");
              setMeetingBuilderOpen(true);
            }}
            type="button"
          >
            {text.setup.editReminders}
          </button>
          <button
            className="rounded-md border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={meetingSettingsStatus === "saving"}
            onClick={() => saveMeetingSettings(false)}
            type="button"
          >
            {meetingSettingsStatus === "saving" ? text.builder.saving : text.setup.savePage}
          </button>
        </div>
        {meetingStatusMessage ? (
          <p
            className={`mt-3 rounded-md border px-3 py-2 text-sm font-semibold ${
              meetingSettingsStatus === "error" || meetingNotificationStatus === "error"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-emerald-200 bg-white text-emerald-900"
            }`}
          >
            {meetingStatusMessage}
          </p>
        ) : null}
      </article>

      <article className="rounded-lg border border-blue-100 bg-white p-5">
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
              {text.calendarSetup.eyebrow}
            </p>
            <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
              {text.calendarSetup.title}
            </h4>
            <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
              {text.calendarSetup.description}
            </p>
          </div>
          <div className="grid w-full min-w-0 gap-3 text-sm md:grid-cols-3 2xl:max-w-2xl">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.calendarSetup.calendarForPage}
              <select
                className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) => {
                  const provider = event.target.value as CalendarProvider;
                  setCalendarIntegrations((current) =>
                    normalizeCalendarIntegrationSelection(
                      {
                        ...current,
                        defaultMeetingProvider: getMeetingProviderForCalendar(provider),
                        defaultProvider: provider,
                      },
                      provider,
                    ),
                  );
                }}
                value={calendarIntegrations.defaultProvider}
              >
                {calendarProviderOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.calendarSetup.meetingProviderForPage}
              <select
                className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setCalendarIntegrations((current) => ({
                    ...current,
                    defaultMeetingProvider: event.target.value as MeetingProvider,
                  }))
                }
                value={calendarIntegrations.defaultMeetingProvider}
              >
                {meetingProviderOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.calendarSetup.syncMode}
              <select
                className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setCalendarIntegrations((current) => ({
                    ...current,
                    syncMode: event.target.value as CalendarIntegrationState["syncMode"],
                  }))
                }
                value={calendarIntegrations.syncMode}
              >
                {syncModeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {!hasConnectedCalendarProvider ? (
          <div className="mt-5 rounded-lg border border-dashed border-blue-200 bg-blue-50 p-4 text-blue-950">
            <p className="text-sm font-semibold">{text.calendarSetup.neutralQuestion}</p>
            <p className="mt-1 text-sm text-blue-900">{text.calendarSetup.neutralDescription}</p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {calendarProviderOptions.map((option) => {
            const config = calendarIntegrations[option.id];
            const isSelectedForPage = calendarIntegrations.defaultProvider === option.id;
            const meetingIsSelectedForPage =
              calendarIntegrations.defaultMeetingProvider === option.meetingProvider;
            const calendarStatusLabel = getProviderSelectionStatusLabel(
              isSelectedForPage,
              config.connected,
              text,
            );
            const meetingStatusLabel = getProviderSelectionStatusLabel(
              meetingIsSelectedForPage,
              config.meetingConnected,
              text,
            );

            return (
              <div
                className={`rounded-lg border p-4 ${
                  hasConnectedCalendarProvider && isSelectedForPage
                    ? "border-blue-300 bg-blue-50"
                    : "border-stone-200 bg-stone-50"
                }`}
                key={option.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                      {option.label}
                    </p>
                    <h5 className="mt-1 break-words text-lg font-semibold text-slate-950">
                      {option.title} + {option.meetingTitle}
                    </h5>
                    <p className="mt-2 break-words text-sm text-stone-600">
                      {option.description}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                      !config.connected
                        ? "bg-amber-100 text-amber-800"
                        : isSelectedForPage
                          ? "bg-blue-100 text-blue-800"
                          : "bg-emerald-100 text-emerald-800"
                    }`}
                  >
                    {calendarStatusLabel}
                  </span>
                </div>

                <div className="mt-4 grid gap-3">
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.calendarSetup.accountEmail}
                    <input
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                      onChange={(event) =>
                        updateProviderConfig(option.id, "accountEmail", event.target.value)
                      }
                      placeholder={
                        option.id === "google" ? "name@unternehmen.com" : "name@unternehmen.com"
                      }
                      type="email"
                      value={config.accountEmail}
                    />
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.calendarSetup.calendarLinkOrId}
                    <input
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                      onChange={(event) =>
                        updateProviderConfig(option.id, "calendarUrl", event.target.value)
                      }
                      placeholder={
                        option.id === "google"
                          ? text.calendarSetup.googleCalendarPlaceholder
                          : text.calendarSetup.microsoftCalendarPlaceholder
                      }
                      type="text"
                      value={config.calendarUrl}
                    />
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.calendarSetup.meetingLinkTemplate}
                    <input
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                      onChange={(event) =>
                        updateProviderConfig(option.id, "meetingLinkTemplate", event.target.value)
                      }
                      type="text"
                      value={config.meetingLinkTemplate}
                    />
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    onClick={() => connectCalendarProvider(option.id)}
                    type="button"
                  >
                    {text.calendarSetup.connect(option.title)}
                  </button>
                  <button
                    className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-950 hover:bg-blue-50"
                    onClick={() => connectMeetingProvider(option.id)}
                    type="button"
                  >
                    {text.calendarSetup.connect(option.meetingTitle)}
                  </button>
                  {config.connected && !isSelectedForPage ? (
                    <button
                      className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                      onClick={() =>
                        setCalendarIntegrations((current) =>
                          normalizeCalendarIntegrationSelection(
                            {
                              ...current,
                              defaultMeetingProvider: option.meetingProvider,
                              defaultProvider: option.id,
                            },
                            option.id,
                          ),
                        )
                      }
                      type="button"
                    >
                      {text.calendarSetup.selectForPage}
                    </button>
                  ) : null}
                  {config.connected ? (
                    <button
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
                      onClick={() => void disconnectCalendarProvider(option.id)}
                      type="button"
                    >
                      {text.calendarSetup.disconnect}
                    </button>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-2 text-xs text-stone-600 sm:grid-cols-2">
                  <span className="rounded-md bg-white px-2 py-1">
                    {text.calendarSetup.calendar} {calendarStatusLabel}
                  </span>
                  <span className="rounded-md bg-white px-2 py-1">
                    {text.calendarSetup.meeting} {meetingStatusLabel}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-950">
          {text.calendarSetup.selectedSummary(selectedProviderLabel, selectedMeetingProviderLabel)}{" "}
          {selectedProviderConfig.connected
            ? selectedProviderConfig.accountEmail
              ? text.calendarSetup.connectedWith(selectedProviderConfig.accountEmail)
              : text.calendarSetup.connectedWithCustomerAccount
            : text.calendarSetup.missingConnection}
        </div>
      </article>

      <article className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              {text.share.eyebrow}
            </p>
            <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
              {text.share.title}
            </h4>
            <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
              {text.share.description}
            </p>
          </div>
          <div className="grid w-full gap-3 text-sm md:grid-cols-2 xl:max-w-2xl">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.share.meetingType}
              <select
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setShareConfig((current) => ({
                    ...current,
                    meetingType: event.target.value as MeetingType,
                  }))
                }
                value={shareConfig.meetingType}
              >
                <option value="personal">{text.share.meetingTypes.personal}</option>
                <option value="group">{text.share.meetingTypes.group}</option>
                <option value="round_robin">{text.share.meetingTypes.round_robin}</option>
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.share.slug}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setShareConfig((current) => ({ ...current, slug: slugify(event.target.value) }))
                }
                placeholder="pipeline-audit"
                type="text"
                value={shareConfig.slug}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.share.buttonText}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setShareConfig((current) => ({ ...current, buttonLabel: event.target.value }))
                }
                placeholder={text.share.buttonPlaceholder}
                type="text"
                value={shareConfig.buttonLabel}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {text.share.trackingSource}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) =>
                  setShareConfig((current) => ({ ...current, utmSource: event.target.value }))
                }
                placeholder="crm"
                type="text"
                value={shareConfig.utmSource}
              />
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
              <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.share.embedHeight}
                <input
                  className="min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                  min="520"
                  onChange={(event) =>
                    setShareConfig((current) => ({ ...current, height: event.target.value }))
                  }
                  type="number"
                  value={shareConfig.height}
                />
              </label>
              <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {text.share.theme}
                <select
                  className="min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                  onChange={(event) =>
                    setShareConfig((current) => ({
                      ...current,
                      theme: event.target.value as MeetingShareConfig["theme"],
                    }))
                  }
                  value={shareConfig.theme}
                >
                  <option value="light">{text.share.light}</option>
                  <option value="dark">{text.share.dark}</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="grid gap-2">
            {meetingShareOptions.map((option) => (
              <button
                className={`rounded-md border px-3 py-3 text-left transition ${
                  shareMode === option.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-slate-950 hover:border-slate-300 hover:bg-white"
                }`}
                key={option.id}
                onClick={() => {
                  setShareMode(option.id);
                  setShareNotice("");
                }}
                type="button"
              >
                <span className="block text-sm font-semibold">{option.label}</span>
                <span
                  className={`mt-1 block text-xs ${
                    shareMode === option.id ? "text-slate-200" : "text-stone-600"
                  }`}
                >
                  {option.description}
                </span>
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                  {text.share.output}
                </p>
                <h5 className="mt-1 text-base font-semibold text-slate-950">
                  {selectedShareOption.label}
                </h5>
              </div>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() =>
                  copyShareArtifact(selectedShareOption.label, shareArtifacts[shareMode])
                }
                type="button"
              >
                {text.share.copy}
              </button>
            </div>

            <textarea
              className="mt-3 min-h-40 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-slate-950 outline-none focus:border-slate-950"
              readOnly
              value={shareArtifacts[shareMode]}
            />

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-white px-2 py-1 text-stone-600">
                {text.share.provider} {selectedProviderLabel}
              </span>
              <span className="rounded-md bg-white px-2 py-1 text-stone-600">
                {text.share.meeting} {selectedMeetingProviderLabel}
              </span>
              <span className="rounded-md bg-white px-2 py-1 text-stone-600">
                {text.share.tracking} {shareConfig.utmSource || "crm"}
              </span>
            </div>

            {shareMode === "link" ? (
              <a
                className="mt-3 inline-flex rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-stone-100"
                href={trackedBookingUrl}
                rel="noreferrer"
                target="_blank"
              >
                {text.builder.openBookingPage}
              </a>
            ) : null}

            {shareMode === "embed" ? (
              <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
                <iframe
                  className="h-96 w-full"
                  src={trackedBookingUrl}
                  title={text.share.bookingPreviewTitle}
                />
              </div>
            ) : null}

            {shareMode === "qr" ? (
              <div className="mt-3 grid gap-3 rounded-md border border-blue-100 bg-blue-50 p-3 sm:grid-cols-[auto_1fr]">
                <Image
                  alt={text.share.qrAlt}
                  className="h-36 w-36 rounded-md border border-blue-100 bg-white p-2"
                  height={144}
                  src={qrImageUrl}
                  unoptimized
                  width={144}
                />
                <div className="min-w-0 text-xs text-blue-950">
                  <p className="font-semibold">{text.share.shortLink}</p>
                  <a
                    className="mt-1 block break-words underline"
                    href={shortBookingUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {shortBookingUrl}
                  </a>
                  <p className="mt-2 text-blue-900">
                    {text.share.qrDescription}
                  </p>
                </div>
              </div>
            ) : null}

            {shareNotice ? (
              <p className="mt-3 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                {shareNotice}
              </p>
            ) : null}
          </div>
        </div>
      </article>

      <article className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-emerald-950">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">
              {text.liveIntegrationEyebrow}
            </p>
            <h4 className="mt-1 break-words text-lg font-semibold">{text.liveIntegrationTitle}</h4>
            <p className="mt-2 max-w-3xl break-words text-sm text-emerald-900">
              {text.liveSyncDescription}
            </p>
            <p
              className={`mt-3 break-words rounded-md border px-3 py-2 text-sm font-semibold ${
                liveCalendarAction.status === "error"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : liveCalendarAction.status === "success"
                    ? "border-emerald-200 bg-white text-emerald-900"
                    : "border-emerald-200 bg-white/70 text-emerald-900"
              }`}
            >
              {liveCalendarMessage}
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
            <button
              className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
              disabled={liveCalendarAction.status === "running" || !selectedEvent || !selectedProviderConfig.connected}
              onClick={syncLiveTeamsMeeting}
              type="button"
            >
              {liveCalendarAction.status === "running"
                ? text.liveSyncRunning
                : text.syncWithProvider(selectedProviderLabel)}
            </button>
            {liveCalendarAction.url ? (
              <a
                className="rounded-md border border-emerald-200 bg-white px-4 py-2 text-center text-sm font-semibold text-emerald-950 hover:bg-emerald-100"
                href={liveCalendarAction.url}
                rel="noreferrer"
                target="_blank"
              >
                {text.openSyncedEvent}
              </a>
            ) : null}
          </div>
        </div>
      </article>

      <section className="grid gap-4 xl:grid-cols-[1fr_380px]">
        {activeView === "bookings" ? (
          <article className="rounded-lg border border-stone-200 bg-white p-4 xl:col-span-2">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  {text.bookingOverview.eyebrow}
                </p>
                <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
                  {text.bookingOverview.title}
                </h4>
                <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
                  {text.bookingOverview.description}
                </p>
              </div>
              <button
                className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={meetingBookingOverviewStatus === "loading"}
                onClick={loadMeetingBookingOverview}
                type="button"
              >
                {meetingBookingOverviewStatus === "loading"
                  ? text.bookingOverview.refreshing
                  : text.bookingOverview.refresh}
              </button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {[
                [text.bookingOverview.total, meetingBookingOverview.metrics.totalBookings],
                [text.bookingOverview.requested, meetingBookingOverview.metrics.requestedBookings],
                [text.bookingOverview.queued, meetingBookingOverview.metrics.queuedNotifications],
                [text.bookingOverview.sent, meetingBookingOverview.metrics.sentNotifications],
                [text.bookingOverview.failed, meetingBookingOverview.metrics.failedNotifications],
              ].map(([label, value]) => (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={label}>
                  <p className="text-2xl font-semibold text-slate-950">{value}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {label}
                  </p>
                </div>
              ))}
            </div>

            {meetingBookingOverviewStatus === "error" ? (
              <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                {text.bookingOverview.loadError}
              </p>
            ) : null}
            {bookingActionMessage ? (
              <p className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
                {bookingActionMessage}
              </p>
            ) : null}

            <div className="mt-5 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h5 className="text-base font-semibold text-slate-950">{text.bookingOverview.requests}</h5>
                  <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-600">
                    {meetingBookingOverview.bookings.length}
                  </span>
                </div>
                <div className="mt-3 grid gap-3">
                  {meetingBookingOverview.bookings.length > 0 ? (
                    meetingBookingOverview.bookings.map((booking) => (
                      <article
                        className="rounded-lg border border-stone-200 bg-white p-3"
                        key={booking.id}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="break-words text-sm font-semibold text-slate-950">
                              {booking.title}
                            </p>
                            <p className="mt-1 break-words text-xs text-stone-500">
                              {booking.contactName} · {booking.contactEmail}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-900">
                            {getBookingStatusLabel(booking.status, text)}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-stone-600 sm:grid-cols-2">
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.start} {formatDateTime(booking.startsAt, locale)}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.meeting}{" "}
                            {getMeetingProviderLabel(booking.meetingProvider as MeetingProvider, text)}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.calendar}{" "}
                            {booking.calendarProvider === "google" ? "Google" : "Microsoft"}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.source} {getCrmEnumLabel(booking.source, language)}
                          </span>
                        </div>
                        {booking.contactNote ? (
                          <p className="mt-3 break-words rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-950">
                            {booking.contactNote}
                          </p>
                        ) : null}
                        {booking.status !== "confirmed" && booking.status !== "cancelled" ? (
                          <button
                            className="mt-3 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                            disabled={confirmingBookingId === booking.id}
                            onClick={() => confirmBooking(booking.id)}
                            type="button"
                          >
                            {confirmingBookingId === booking.id
                              ? text.bookingOverview.confirming
                              : text.bookingOverview.confirmAsCalendarEvent}
                          </button>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-500">
                      {text.bookingOverview.noRequests}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h5 className="text-base font-semibold text-slate-950">{text.bookingOverview.timeline}</h5>
                  <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-600">
                    {filteredNotifications.length}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    ["all", text.bookingOverview.filters.all],
                    ["queued", text.bookingOverview.filters.queued],
                    ["sent", text.bookingOverview.filters.sent],
                    ["failed", text.bookingOverview.filters.failed],
                  ].map(([id, label]) => (
                    <button
                      className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                        notificationFilter === id
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-white text-stone-700 hover:border-stone-300"
                      }`}
                      key={id}
                      onClick={() => setNotificationFilter(id as NotificationFilter)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 grid gap-3">
                  {filteredNotifications.length > 0 ? (
                    filteredNotifications.map((notification) => (
                      <article
                        className="rounded-lg border border-stone-200 bg-white p-3"
                        key={notification.id}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                              {getNotificationKindLabel(notification.kind, text)}
                            </p>
                            <p className="mt-1 break-words text-sm font-semibold text-slate-950">
                              {resolveNotificationSubject(notification)}
                            </p>
                            <p className="mt-1 break-words text-xs text-stone-500">
                              {notification.contactName || text.bookingOverview.contactFallback} ·{" "}
                              {notification.recipientEmail}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${getNotificationStatusClass(
                              notification.status,
                            )}`}
                          >
                            {getNotificationStatusLabel(notification.status, text)}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-stone-600 sm:grid-cols-2">
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.queued}: {formatDateTime(notification.scheduledFor, locale)}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.provider}{" "}
                            {notification.provider || text.bookingOverview.openProvider}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.attempts} {notification.attempts}
                          </span>
                          <span className="rounded-md bg-stone-50 px-2 py-1">
                            {text.bookingOverview.appointment} {notification.bookingTitle || "-"}
                          </span>
                        </div>
                        {notification.error ? (
                          <p className="mt-3 break-words rounded-md bg-red-50 px-3 py-2 text-xs text-red-900">
                            {notification.error}
                          </p>
                        ) : null}
                        {notification.status === "failed" ? (
                          <button
                            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={retryingNotificationId === notification.id}
                            onClick={() => retryNotification(notification.id)}
                            type="button"
                          >
                            {retryingNotificationId === notification.id
                              ? text.bookingOverview.retrying
                              : text.bookingOverview.retry}
                          </button>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-500">
                      {text.bookingOverview.noMessages}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </article>
        ) : (
          <>
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
                        {text.statusLabels[item.event.status]}
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
                          hasOnlineMeetingLink(item.event)
                            ? isSelected
                              ? "bg-emerald-300/20 text-emerald-100"
                              : "bg-emerald-50 text-emerald-800"
                            : isSelected
                              ? "bg-white/10 text-white"
                              : "bg-amber-50 text-amber-800"
                        }`}
                      >
                        {getMeetingStatusLabel(item.event, text)}
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
              [text.calendarLabel, getCalendarProviderLabel(selectedEventProvider, text)],
              [text.meetingLabel, getMeetingStatusLabel(selectedEvent?.event, text)],
              [text.status, selectedEvent ? text.statusLabels[selectedEvent.event.status] : undefined],
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

          {selectedEvent?.event.notes ? (
            <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
              <p className="text-sm font-semibold text-slate-950">{text.notes}</p>
              <p className="mt-2 break-words text-sm text-stone-700">{selectedEvent.event.notes}</p>
            </div>
          ) : null}

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
                      {getCrmTaskDueLabel(task.due, language)} · {getCrmTaskPriorityLabel(task.priority, language)}
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
              <span>{text.graphFields.subject} · {selectedEvent?.event.title ?? "-"}</span>
              <span>{text.graphFields.start} · {selectedEvent?.event.startsAt ?? "-"}</span>
              <span>{text.graphFields.end} · {selectedEvent?.event.endsAt ?? "-"}</span>
              <span>{text.graphFields.provider} · {selectedEventProvider}</span>
              <span>{text.graphFields.joinUrl} · {getMeetingStatusLabel(selectedEvent?.event, text)}</span>
            </div>
          </div>
        </aside>
          </>
        )}
      </section>
    </section>
  );
}
