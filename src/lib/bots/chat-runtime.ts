import type { AppSession } from "@/lib/auth/session";
import { runCrmBotTool } from "@/lib/bots/agent-tools";
import {
  buildSafeBotReply,
  documentApprovedFromPayload,
  evaluateBotAction,
  findBotPromptViolations,
  getBotRuntimeControls,
  sanitizeBotReply,
  type BotPolicyDecision,
  type BotPolicyViolation,
} from "@/lib/bots/policy";
import { sendBotDocument, type BotDocumentDeliveryResult } from "@/lib/bots/provider-actions";
import {
  createMeetingBookingWithNotifications,
  getPublicMeetingAvailability,
  getPublicMeetingPageSettings,
  listMeetingPageSettings,
  type MeetingPageSettings,
} from "@/lib/db/meeting-repositories";
import {
  createApprovalRequest,
  getOrCreateBotConversation,
  insertBotDocumentSend,
  insertBotMessage,
  insertBotToolCall,
  insertNewsletterSend,
  linkBotConversationToCrmEntities,
  listBotMessages,
  searchPersistedKnowledge,
  updateBotConversationStatus,
  updateBotDocumentSendDelivery,
  upsertBotCrmEntities,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import type { LanguageCode } from "@/lib/i18n";
import { embedText } from "@/lib/integrations/embeddings";
import { generateModelReply, getModelProviderStatus } from "@/lib/integrations/model-provider";
import { getPublicMediaUrl, listWorkspaceMedia, type MediaAsset } from "@/lib/media-store";

export type BotChatRunResult = {
  approvalId: string | null;
  autonomy: {
    controls: ReturnType<typeof getBotRuntimeControls>;
    decisions: BotPolicyDecision[];
    documentDelivery: BotDocumentDeliveryResult | null;
    meetingBooking: Awaited<ReturnType<typeof createMeetingBookingWithNotifications>> | null;
    replyBlocked: boolean;
  };
  botName: string;
  conversationId: string;
  externalModelCall: boolean;
  humanApprovalRequired: boolean;
  message: {
    content: string;
    role: "assistant";
  };
  model: string;
  persisted: boolean;
  provider: string;
  providerStatus: ReturnType<typeof getModelProviderStatus>;
  runSummary: {
    approvalId: string | null;
    documentRequested: boolean;
    humanHandoffRequired: boolean;
    humanApprovalRequired: boolean;
    meetingRequested: boolean;
    nextAction: string;
    score: number | null;
  };
  toolResults: unknown[];
};

type ToolExecution = ReturnType<typeof runCrmBotTool>;

type BotMeetingSlot = {
  date: string;
  label: string;
  time: string;
  value: string;
};

type BotMeetingContext = {
  bookingUrl: string | null;
  calendarProvider: string;
  meetingProvider: string;
  page: MeetingPageSettings | null;
  selectedSlot: BotMeetingSlot | null;
  slots: BotMeetingSlot[];
  slug: string;
};

type PendingMeetingSelection = {
  calendarProvider?: string;
  meetingProvider?: string;
  selectedDate?: string;
  slot?: string;
  slug?: string;
};

function isCustomerFacingChannel(channel: string) {
  return !["admin", "internal", "test"].includes(channel.trim().toLowerCase());
}

function appendRequiredCitations(input: {
  language: LanguageCode;
  sources: Array<{ title: string; url?: string | null }>;
  text: string;
}) {
  if (!input.sources.length || /\b(Quellen|Sources):/i.test(input.text)) return input.text;

  const sources = input.sources
    .slice(0, 3)
    .map((source) => source.url ? `${source.title} (${source.url})` : source.title)
    .join("; ");
  const label = input.language === "de" ? "Quellen" : "Sources";

  return `${input.text}\n\n${label}: ${sources}`;
}

export function getBotPrompt(input: Record<string, unknown>) {
  return String(input.prompt ?? input.text ?? "").trim();
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toPublicUrl(value: string | null | undefined, requestUrl?: string) {
  if (!value) return null;

  try {
    return new URL(value, requestUrl).toString();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\u00e4/g, "ae")
    .replace(/\u00f6/g, "oe")
    .replace(/\u00fc/g, "ue")
    .replace(/\u00df/g, "ss");
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function getLocalDateKey(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDatePreference(text: string) {
  const normalized = normalizeText(text);
  const iso = normalized.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const germanDate = normalized.match(/\b([0-3]?\d)[./-]([01]?\d)(?:[./-](20\d{2}|\d{2}))?\b/);
  if (germanDate) {
    const now = new Date();
    const rawYear = germanDate[3] ? Number(germanDate[3]) : now.getFullYear();
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const candidate = new Date(year, Number(germanDate[2]) - 1, Number(germanDate[1]));
    if (!Number.isNaN(candidate.getTime())) return getLocalDateKey(candidate);
  }

  const today = new Date();
  if (/\bheute\b/.test(normalized)) return getLocalDateKey(today);
  if (/\bmorgen\b/.test(normalized)) return getLocalDateKey(addDays(today, 1));
  if (/\buebermorgen\b/.test(normalized)) return getLocalDateKey(addDays(today, 2));

  const weekdays: Record<string, number> = {
    sonntag: 0,
    montag: 1,
    dienstag: 2,
    mittwoch: 3,
    donnerstag: 4,
    freitag: 5,
    samstag: 6,
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const requestedWeekday = Object.entries(weekdays).find(([label]) => new RegExp(`\\b${label}\\b`).test(normalized))?.[1];
  if (requestedWeekday !== undefined) {
    for (let offset = 0; offset <= 21; offset += 1) {
      const candidate = addDays(today, offset);
      if (candidate.getDay() === requestedWeekday) return getLocalDateKey(candidate);
    }
  }

  return null;
}

function parseTimePreference(text: string) {
  const normalized = normalizeText(text);
  const clock = normalized.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (clock) return `${pad2(Number(clock[1]))}:${clock[2]}`;

  const hour = normalized.match(/\b([01]?\d|2[0-3])\s*(?:uhr|h)(?:\s*([0-5]\d))?\b/);
  if (hour) return `${pad2(Number(hour[1]))}:${hour[2] ?? "00"}`;

  return null;
}

function parseSlotOrdinal(text: string) {
  const normalized = normalizeText(text);
  if (/\b(1\.|erste|erster|erstes|ersten|first)\b/.test(normalized)) return 0;
  if (/\b(2\.|zweite|zweiter|zweites|zweiten|second)\b/.test(normalized)) return 1;
  if (/\b(3\.|dritte|dritter|drittes|dritten|third)\b/.test(normalized)) return 2;
  if (/\b(4\.|vierte|vierter|viertes|vierten|fourth)\b/.test(normalized)) return 3;
  if (/\b(5\.|fuenfte|fuenfter|fuenftes|fuenften|fifth)\b/.test(normalized)) return 4;
  return null;
}

function looksLikeMeetingSelection(text: string) {
  return Boolean(parseTimePreference(text) || parseSlotOrdinal(text) !== null || parseDatePreference(text));
}

function historySuggestsMeetingSelection(history: Array<{ role: "user" | "assistant"; content: string }>) {
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant")?.content ?? "";
  const normalized = normalizeText(lastAssistant);
  return /(frei sind|termin direkt buchen|slot ist frei|available slots|book the appointment|appointment directly)/i.test(normalized);
}

function looksLikeMeetingContactUpdate(text: string) {
  return Boolean(extractEmailFromText(text) || /\b(name|e-mail|email|mail)\b/i.test(text));
}

function getPendingMeetingSelection(
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; metadata: unknown }>,
): PendingMeetingSelection | null {
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
  const metadata = asRecord(lastAssistant?.metadata);
  const pending = asRecord(metadata.pendingMeeting);
  const selectedDate = typeof pending.selectedDate === "string" ? pending.selectedDate : "";
  const slot = typeof pending.slot === "string" ? pending.slot : "";
  const slug = typeof pending.slug === "string" ? pending.slug : "";

  if (!selectedDate || !slot || !slug) return null;

  return {
    calendarProvider: typeof pending.calendarProvider === "string" ? pending.calendarProvider : undefined,
    meetingProvider: typeof pending.meetingProvider === "string" ? pending.meetingProvider : undefined,
    selectedDate,
    slot,
    slug,
  };
}

function normalizeSlotValue(value: string | null) {
  if (!value) return null;
  const time = parseTimePreference(value);
  return time;
}

function formatMeetingSlotLabel(date: string, time: string, language: LanguageCode) {
  const [year, month, day] = date.split("-").map(Number);
  const formattedDate = new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));

  return `${formattedDate}, ${time}`;
}

function getCalendarProviderFromPage(page: MeetingPageSettings | null) {
  const config = asRecord(page?.calendarIntegrations);
  const provider = typeof config.defaultProvider === "string" ? config.defaultProvider : null;
  return provider === "google" ? "google" : "microsoft";
}

function getMeetingProviderFromPage(page: MeetingPageSettings | null, calendarProvider: string) {
  const config = asRecord(page?.calendarIntegrations);
  const provider = typeof config.defaultMeetingProvider === "string" ? config.defaultMeetingProvider : null;
  if (provider === "google-meet" || provider === "microsoft-teams" || provider === "manual-link" || provider === "phone") {
    return provider;
  }

  return calendarProvider === "google" ? "google-meet" : "microsoft-teams";
}

function buildBookingUrl(slug: string, requestUrl?: string) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || (requestUrl ? new URL(requestUrl).origin : "https://www.novalure-crm.app");
  try {
    return new URL(`/book/${slug}`, origin).toString();
  } catch {
    return null;
  }
}

async function resolveMeetingSlug(input: {
  payload: Record<string, unknown>;
  pendingMeeting?: PendingMeetingSelection | null;
  session: AppSession;
}) {
  const explicit =
    asOptionalString(input.payload.slug) ??
    asOptionalString(input.payload.meetingPage) ??
    asOptionalString(input.payload.meetingSlug);
  if (explicit) return explicit;
  if (input.pendingMeeting?.slug) return input.pendingMeeting.slug;

  const envSlug = process.env.NOVALURE_BOT_DEFAULT_MEETING_SLUG?.trim() || process.env.NOVALURE_MEETING_PAGE_SLUG?.trim();
  if (envSlug) return envSlug;

  const pages = await listMeetingPageSettings({ session: input.session, limit: 1 }).catch(() => null);
  return pages?.pages[0]?.slug ?? "pipeline-audit";
}

function selectMeetingSlot(input: {
  explicitDate: string | null;
  explicitSlot: string | null;
  prompt: string;
  slots: BotMeetingSlot[];
}) {
  const requestedDate = input.explicitDate ?? parseDatePreference(input.prompt);
  const requestedTime = normalizeSlotValue(input.explicitSlot) ?? parseTimePreference(input.prompt);
  const ordinal = parseSlotOrdinal(input.prompt);
  const dateFiltered = requestedDate ? input.slots.filter((slot) => slot.date === requestedDate) : input.slots;

  if (requestedTime) {
    return (dateFiltered.length ? dateFiltered : input.slots).find((slot) => slot.time === requestedTime) ?? null;
  }

  if (ordinal !== null) {
    return (dateFiltered.length ? dateFiltered : input.slots)[ordinal] ?? null;
  }

  return null;
}

async function loadBotMeetingContext(input: {
  language: LanguageCode;
  payload: Record<string, unknown>;
  pendingMeeting?: PendingMeetingSelection | null;
  prompt: string;
  requestUrl?: string;
  session: AppSession;
}): Promise<BotMeetingContext> {
  const slug = await resolveMeetingSlug({ payload: input.payload, pendingMeeting: input.pendingMeeting, session: input.session });
  const page = await getPublicMeetingPageSettings(slug).catch(() => null);
  const calendarProvider = asOptionalString(input.payload.calendarProvider) ?? input.pendingMeeting?.calendarProvider ?? getCalendarProviderFromPage(page);
  const meetingProvider =
    asOptionalString(input.payload.meetingProvider) ??
    input.pendingMeeting?.meetingProvider ??
    getMeetingProviderFromPage(page, calendarProvider);
  const requestedDate =
    asOptionalString(input.payload.selectedDate) ??
    asOptionalString(input.payload.date) ??
    input.pendingMeeting?.selectedDate ??
    parseDatePreference(input.prompt);
  const firstAvailability = await getPublicMeetingAvailability({
    date: requestedDate ?? undefined,
    slug,
  }).catch(() => null);
  const candidateDates = Array.from(
    new Set([
      firstAvailability?.date,
      ...(firstAvailability?.days.filter((day) => day.available).map((day) => day.date) ?? []),
    ].filter(Boolean) as string[]),
  ).slice(0, 7);
  const slots: BotMeetingSlot[] = [];

  for (const date of candidateDates) {
    if (slots.length >= 6) break;
    const availability =
      date === firstAvailability?.date
        ? firstAvailability
        : await getPublicMeetingAvailability({ date, slug }).catch(() => null);

    availability?.slots
      .filter((slot) => slot.available)
      .slice(0, 6 - slots.length)
      .forEach((slot) => {
        slots.push({
          date,
          label: formatMeetingSlotLabel(date, slot.time, input.language),
          time: slot.time,
          value: `${date} ${slot.time}`,
        });
      });
  }

  const selectedSlot = selectMeetingSlot({
    explicitDate: asOptionalString(input.payload.selectedDate) ?? asOptionalString(input.payload.date) ?? input.pendingMeeting?.selectedDate ?? null,
    explicitSlot: asOptionalString(input.payload.slot) ?? asOptionalString(input.payload.selectedSlot) ?? input.pendingMeeting?.slot ?? null,
    prompt: input.prompt,
    slots,
  });

  return {
    bookingUrl: buildBookingUrl(slug, input.requestUrl),
    calendarProvider,
    meetingProvider,
    page,
    selectedSlot,
    slots,
    slug,
  };
}

function getCustomerDataValue(customerData: ToolExecution, field: "email" | "name" | "phone") {
  if (customerData.tool !== "capture_customer_data") return null;
  return customerData.contact[field] ?? null;
}

function extractEmailFromText(text: string) {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function extractNameFromText(text: string, email: string | null) {
  const hasNameCue = /\b(mein name ist|ich bin|name ist|my name is|i am)\b/i.test(text);
  if (!email && !hasNameCue) return null;

  const withoutEmail = email ? text.replace(email, " ") : text;
  const normalized = withoutEmail
    .replace(/\b(mein name ist|ich bin|name ist|my name is|i am)\b/gi, " ")
    .replace(/[^A-Za-z\u00c0-\u017f\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = normalized.split(" ").filter((part) => part.length > 1);

  if (parts.length >= 2 && parts.length <= 4) return parts.join(" ");
  return null;
}

function getDocumentRecipient(input: {
  customerData: ToolExecution;
  payload: Record<string, unknown>;
}) {
  return {
    email:
      asOptionalString(input.payload.recipientEmail) ??
      asOptionalString(input.payload.email) ??
      getCustomerDataValue(input.customerData, "email"),
    name:
      asOptionalString(input.payload.recipientName) ??
      asOptionalString(input.payload.contactName) ??
      asOptionalString(input.payload.name) ??
      getCustomerDataValue(input.customerData, "name"),
    phone:
      asOptionalString(input.payload.recipientPhone) ??
      asOptionalString(input.payload.phone) ??
      asOptionalString(input.payload.contactRef) ??
      getCustomerDataValue(input.customerData, "phone"),
  };
}

async function resolveDocumentAsset(input: {
  mediaAssetId?: string | null;
  session: AppSession;
}) {
  if (!input.mediaAssetId) return null;

  const media = await listWorkspaceMedia(input.session.workspaceId);
  return media.assets.find((asset) => asset.id === input.mediaAssetId) ?? null;
}

function getMeetingBookingPayload(
  payload: Record<string, unknown>,
  customerData: ToolExecution,
  meetingContext: BotMeetingContext | null,
) {
  const slug =
    asOptionalString(payload.slug) ??
    asOptionalString(payload.meetingPage) ??
    asOptionalString(payload.meetingSlug) ??
    meetingContext?.slug ??
    "";
  const explicitDate = asOptionalString(payload.selectedDate) ?? asOptionalString(payload.date);
  const explicitSlot = normalizeSlotValue(asOptionalString(payload.slot) ?? asOptionalString(payload.selectedSlot));
  const selectedSlot = meetingContext?.selectedSlot ?? null;

  return {
    calendarProvider: asOptionalString(payload.calendarProvider) ?? meetingContext?.calendarProvider ?? "manual",
    contactEmail: asOptionalString(payload.contactEmail) ?? asOptionalString(payload.email) ?? getCustomerDataValue(customerData, "email") ?? "",
    contactName: asOptionalString(payload.contactName) ?? asOptionalString(payload.name) ?? getCustomerDataValue(customerData, "name") ?? "",
    contactNote: asOptionalString(payload.contactNote) ?? asOptionalString(payload.note) ?? "",
    meetingProvider: asOptionalString(payload.meetingProvider) ?? meetingContext?.meetingProvider ?? "microsoft-teams",
    selectedDate: explicitDate ?? selectedSlot?.date ?? "",
    slot: explicitSlot ?? selectedSlot?.time ?? "",
    slug,
  };
}

function getMissingBookingFields(meetingPayload: ReturnType<typeof getMeetingBookingPayload>) {
  return [
    !meetingPayload.contactName ? "name" : null,
    !meetingPayload.contactEmail ? "email" : null,
    !meetingPayload.selectedDate || !meetingPayload.slot ? "slot" : null,
    !meetingPayload.slug ? "meeting_page" : null,
  ].filter(Boolean) as string[];
}

function buildMeetingReply(input: {
  booking: Awaited<ReturnType<typeof createMeetingBookingWithNotifications>> | null;
  bookingDecision: BotPolicyDecision | null;
  context: BotMeetingContext | null;
  language: LanguageCode;
  meetingPayload: ReturnType<typeof getMeetingBookingPayload>;
}) {
  if (!input.context) return null;

  const selected = input.context.selectedSlot;
  const missing = getMissingBookingFields(input.meetingPayload);
  const bookingUrl = input.context.bookingUrl ? `\n${input.context.bookingUrl}` : "";
  const slotLines = input.context.slots.slice(0, 5).map((slot, index) => `${index + 1}. ${slot.label}`);
  const bookedSlotLabel = selected?.label ?? `${input.meetingPayload.selectedDate}, ${input.meetingPayload.slot}`;

  if (input.booking?.persisted) {
    return input.language === "de"
      ? `Der Termin ist gebucht: ${bookedSlotLabel}. Die Bestätigung wird über die Meetingseite verarbeitet.`
      : `The appointment is booked: ${bookedSlotLabel}. The confirmation is handled through the meeting page.`;
  }

  if (input.bookingDecision?.mode === "block" && selected && missing.length) {
    const missingLabels = missing
      .map((field) => {
        if (field === "name") return input.language === "de" ? "Name" : "name";
        if (field === "email") return input.language === "de" ? "E-Mail-Adresse" : "email address";
        if (field === "slot") return input.language === "de" ? "Terminzeit" : "appointment time";
        return input.language === "de" ? "Meetingseite" : "meeting page";
      })
      .join(", ");

    return input.language === "de"
      ? `Der Slot ist frei: ${selected.label}. Bitte senden Sie mir noch ${missingLabels}, dann buche ich den Termin direkt.`
      : `That slot is available: ${selected.label}. Please send your ${missingLabels}, then I will book it directly.`;
  }

  if (input.booking && !input.booking.persisted) {
    const bookingFailureReason =
      input.booking.reason ??
      (input.language === "de" ? "Kalender-Sync nicht abgeschlossen" : "calendar sync did not complete");

    return input.language === "de"
      ? `Ich konnte den Termin gerade nicht verbindlich buchen (${bookingFailureReason}). Sie können direkt über die Meetingseite buchen:${bookingUrl}`
      : `I could not book the appointment yet (${bookingFailureReason}). You can book directly through the meeting page:${bookingUrl}`;
  }

  if (!input.context.page) {
    return input.language === "de"
      ? "Ich kann Termine buchen, aber es ist noch keine aktive Meetingseite für den Bot hinterlegt."
      : "I can book appointments, but no active meeting page is configured for the bot yet.";
  }

  if (!slotLines.length) {
    return input.language === "de"
      ? `Ich finde auf der Meetingseite aktuell keine freien Slots. Sie können die Seite direkt prüfen:${bookingUrl}`
      : `I cannot find available slots on the meeting page right now. You can check the page directly:${bookingUrl}`;
  }

  const contactHint =
    input.language === "de"
      ? "Antworten Sie mit Nummer oder Uhrzeit sowie Name und E-Mail, dann buche ich den Termin direkt."
      : "Reply with the number or time plus name and email, then I will book the appointment directly.";

  return input.language === "de"
    ? `Ich kann den Termin direkt buchen. Frei sind:\n${slotLines.join("\n")}\n${contactHint}`
    : `I can book the appointment directly. Available slots are:\n${slotLines.join("\n")}\n${contactHint}`;
}

async function recordDocumentDelivery(input: {
  asset: MediaAsset | null;
  botId: string | null;
  channel: string;
  contactId: string | null;
  conversationId: string;
  customerData: ToolExecution;
  decision: BotPolicyDecision;
  documentName: string;
  documentUrl: string | null;
  payload: Record<string, unknown>;
  session: AppSession;
}) {
  const recipient = getDocumentRecipient({ customerData: input.customerData, payload: input.payload });
  const initialStatus = input.decision.mode === "test" ? "test" : input.decision.allowed ? "queued" : "blocked";
  const documentSendId = await insertBotDocumentSend({
    session: input.session,
    botId: input.botId,
    channel: input.channel,
    contactId: input.contactId,
    conversationId: input.conversationId,
    documentName: input.asset?.name ?? input.documentName,
    mediaAssetId: input.asset?.id ?? null,
    metadata: {
      customerData: recipient,
      decision: input.decision,
      documentUrl: input.documentUrl,
      source: "bot_autonomy",
    },
    sentAt: null,
    status: initialStatus,
  });

  if (!input.decision.allowed || input.decision.mode === "test") {
    return {
      delivery: null,
      documentSendId,
      status: initialStatus,
    };
  }

  const delivery = await sendBotDocument({
    channel: input.channel,
    documentName: input.asset?.name ?? input.documentName,
    documentUrl: input.documentUrl,
    idempotencyKey: `bot-document-send:${documentSendId ?? crypto.randomUUID()}`,
    mediaMimeType: input.asset?.mimeType ?? null,
    recipientEmail: recipient.email,
    recipientName: recipient.name,
    recipientPhone: recipient.phone,
  });
  const sentAt = delivery.status === "sent" ? new Date().toISOString() : null;

  await updateBotDocumentSendDelivery({
    session: input.session,
    documentSendId,
    metadata: {
      delivery,
      deliveredAt: sentAt,
      lastDeliveryAttemptAt: new Date().toISOString(),
    },
    sentAt,
    status: delivery.status,
  });

  if (delivery.deliveryMode === "email" && delivery.recipient) {
    await insertNewsletterSend({
      session: input.session,
      campaignId: null,
      contactId: input.contactId,
      error: delivery.error ?? null,
      metadata: {
        botDocumentSendId: documentSendId,
        channel: input.channel,
        deliveryMode: delivery.deliveryMode,
        source: "bot_autonomy",
      },
      provider: delivery.provider,
      providerMessageId: delivery.messageId ?? null,
      sentAt,
      status: delivery.status,
      subject: `Ihr angefragtes Dokument: ${input.asset?.name ?? input.documentName}`,
      toEmail: delivery.recipient,
    });
  }

  return {
    delivery,
    documentSendId,
    status: delivery.status,
  };
}

export async function runBotChat(input: {
  language: LanguageCode;
  payload: Record<string, unknown>;
  requestUrl?: string;
  session: AppSession;
}) {
  const { language, payload, session } = input;
  const prompt = getBotPrompt(payload);

  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const controls = getBotRuntimeControls(payload);
  const policyDecisions: BotPolicyDecision[] = [];
  const botName = String(payload.botName ?? "CRM AI Agent");
  const model = String(payload.model ?? process.env.NOVALURE_LLM_MODEL ?? "openai/gpt-5.4");
  const botId = typeof payload.botId === "string" ? payload.botId : null;
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const explicitContactId = typeof payload.contactId === "string" ? payload.contactId : null;
  const explicitLeadId = typeof payload.leadId === "string" ? payload.leadId : null;
  const channel = typeof payload.channel === "string" ? payload.channel : "api";
  const customerFacing = payload.customerFacing !== false && isCustomerFacingChannel(channel);
  const promptViolations = findBotPromptViolations(prompt);
  const extractedEmail = extractEmailFromText(prompt);
  const extractedName = extractNameFromText(prompt, extractedEmail);
  const conversationTitle =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : prompt.slice(0, 80) || botName;

  const qualification = runCrmBotTool("qualify_lead", {
    budget: payload.budget,
    need: prompt,
    timeline: payload.timeline,
  });
  const customerData = runCrmBotTool("capture_customer_data", {
    channel,
    consent: payload.consent,
    email: asOptionalString(payload.email) ?? extractedEmail,
    leadName: payload.leadName,
    name: asOptionalString(payload.name) ?? extractedName,
    phone: payload.phone,
    preferredChannel: payload.preferredChannel,
  });
  const leadScore = qualification.tool === "qualify_lead" && typeof qualification.score === "number" ? qualification.score : null;
  const crmDecision = evaluateBotAction({ action: "crm_upsert", controls, risk: "medium" });
  policyDecisions.push(crmDecision);
  const crmSync =
    crmDecision.allowed && crmDecision.mode === "allow"
      ? await upsertBotCrmEntities({
          session,
          channel,
          contactRef: typeof payload.contactRef === "string" ? payload.contactRef : null,
          customerData: customerData.tool === "capture_customer_data" ? customerData.contact : null,
          externalMessageId: typeof payload.externalMessageId === "string" ? payload.externalMessageId : null,
          nextAction:
            leadScore !== null && leadScore >= 70
              ? "Lead qualifiziert - Termin nach Regeln vorbereiten"
              : "Antwort senden und Lead weiter qualifizieren",
          projectId,
          prompt,
          score: leadScore,
          webhookEventId: typeof payload.webhookEventId === "string" ? payload.webhookEventId : null,
        })
      : null;
  const contactId = explicitContactId ?? crmSync?.contactId ?? null;
  const leadId = explicitLeadId ?? crmSync?.leadId ?? null;
  const conversationId =
    (await getOrCreateBotConversation({
      session,
      botId,
      contactId,
      conversationId: typeof payload.conversationId === "string" ? payload.conversationId : null,
      language,
      leadId,
      metadata: {
        botName,
        channel,
        contactRef: payload.contactRef,
        controls,
        externalMessageId: payload.externalMessageId,
        crmSync,
        customerFacing,
        source: payload.source ?? "chat",
        webhookEventId: payload.webhookEventId,
      },
      model,
      projectId,
      title: conversationTitle,
    })) ?? (typeof payload.conversationId === "string" ? payload.conversationId : crypto.randomUUID());

  if (crmSync || explicitContactId || explicitLeadId) {
    await linkBotConversationToCrmEntities({
      session,
      conversationId,
      contactId,
      leadId,
      sync: crmSync,
    });
  }

  await insertBotMessage({
    session,
    conversationId,
    content: prompt,
    metadata: {
      budget: payload.budget,
      channel,
      contactRef: payload.contactRef,
      controls,
      customerFacing,
      externalMessageId: payload.externalMessageId,
      promptViolations,
      source: payload.source ?? "chat",
      timeline: payload.timeline,
      webhookEventId: payload.webhookEventId,
    },
    model,
    role: "user",
  });

  const history = await listBotMessages({ session, conversationId, limit: 16 });
  const modelHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of history.slice(0, -1)) {
    if (message.role === "user" || message.role === "assistant") {
      modelHistory.push({ role: message.role, content: message.content });
    }
  }
  const pendingMeeting = getPendingMeetingSelection(history);

  const knowledgeDecision = evaluateBotAction({ action: "knowledge_search", controls, risk: "low" });
  policyDecisions.push(knowledgeDecision);
  const promptEmbedding = controls.killSwitch
    ? {
        embedding: [] as number[],
        external: false,
        model: "policy-disabled",
        provider: "policy",
        reason: "kill_switch_active",
      }
    : await embedText(prompt);
  const persistedKnowledge =
    knowledgeDecision.allowed && !controls.killSwitch
      ? await searchPersistedKnowledge({
          session,
          projectId,
          query: prompt,
          embedding: promptEmbedding.embedding,
          limit: 5,
        })
      : [];
  const knowledgeContext = persistedKnowledge.map((result) => ({
    citationUrl: result.citationUrl,
    excerpt: result.excerpt,
    score: Number(result.score),
    title: result.title,
  }));
  const knowledge = {
    chunks: persistedKnowledge.map((result) => ({
      chunkId: result.chunkId,
      citationUrl: result.citationUrl,
      embeddingModel: result.embeddingModel,
      excerpt: result.excerpt,
      score: Number(result.score.toFixed(2)),
      sourceId: result.sourceId,
      title: result.title,
    })),
    embedding: {
      external: promptEmbedding.external,
      model: promptEmbedding.model,
      provider: promptEmbedding.provider,
      reason: promptEmbedding.reason ?? null,
    },
    query: prompt,
    sources: persistedKnowledge.map((result) => ({
      confidence: Number(result.score.toFixed(2)),
      title: result.title,
      url: result.citationUrl ?? `/knowledge/${result.chunkId}`,
    })),
    tool: "search_approved_knowledge" as const,
  };
  const knowledgeSources = knowledge.sources;
  const wantsMeeting =
    /(termin|meeting|call|beratung|besichtigung|appointment|slot)/i.test(prompt) ||
    ((looksLikeMeetingSelection(prompt) || looksLikeMeetingContactUpdate(prompt)) &&
      (historySuggestsMeetingSelection(modelHistory) || Boolean(pendingMeeting)));
  const wantsDocument = /(expose|expos|dokument|pdf|unterlage|broschuere|brochure|angebot|offer)/i.test(prompt);
  const hasApprovedKnowledge = knowledgeContext.length > 0;
  const meetingContext = wantsMeeting
    ? await loadBotMeetingContext({
        language,
        payload,
        pendingMeeting,
        prompt,
        requestUrl: input.requestUrl,
        session,
      })
    : null;
  const meetingPrepareDecision = wantsMeeting
    ? evaluateBotAction({
        action: "meeting_prepare",
        controls,
        hasApprovedKnowledge: hasApprovedKnowledge || Boolean(meetingContext?.slots.length),
        risk: "medium",
      })
    : null;
  if (meetingPrepareDecision) policyDecisions.push(meetingPrepareDecision);
  const meetingSlots = wantsMeeting
    ? ({
        tool: "find_meeting_slots" as const,
        meetingPage: meetingContext?.slug,
        slots:
          meetingContext?.slots.map((slot) => ({
            date: slot.date,
            label: slot.label,
            value: slot.value,
          })) ?? [],
      } satisfies ToolExecution)
    : null;
  const meetingPayload = getMeetingBookingPayload(payload, customerData, meetingContext);
  const wantsMeetingBooking = wantsMeeting && Boolean(payload.bookMeeting === true || meetingPayload.selectedDate || meetingPayload.slot);
  const meetingBookingDecision = wantsMeetingBooking
    ? evaluateBotAction({
        action: "meeting_book",
        controls,
        hasApprovedKnowledge: hasApprovedKnowledge || Boolean(meetingContext?.selectedSlot),
        meeting: meetingPayload,
        risk: "high",
      })
    : null;
  if (meetingBookingDecision) policyDecisions.push(meetingBookingDecision);
  const meetingBooking =
    meetingBookingDecision?.allowed && meetingBookingDecision.mode === "allow"
      ? await createMeetingBookingWithNotifications({
          ...meetingPayload,
          requestUrl: input.requestUrl ?? "http://localhost",
          source: "bot_autonomy",
        })
      : meetingBookingDecision?.mode === "test"
        ? { persisted: false, reason: "test_mode_no_external_side_effects" }
        : null;
  const documentSend = wantsDocument
    ? runCrmBotTool("send_document", {
        channel,
        documentId: payload.documentId,
        documentName: payload.documentName,
        mediaAssetId: payload.mediaAssetId,
      })
    : null;
  const mediaAssetId = asOptionalString(payload.mediaAssetId) ?? asOptionalString(payload.documentId) ?? null;
  const documentAsset = wantsDocument
    ? await resolveDocumentAsset({
        mediaAssetId,
        session,
      })
    : null;
  const documentUrl = wantsDocument
    ? toPublicUrl(
        documentAsset ? getPublicMediaUrl(documentAsset, input.requestUrl) : asOptionalString(payload.documentUrl),
        input.requestUrl,
      )
    : null;
  const documentRecipient = getDocumentRecipient({ customerData, payload });
  const documentDecision = wantsDocument
    ? evaluateBotAction({
        action: "document_send",
        controls,
        document: {
          approved: documentApprovedFromPayload(payload),
          publicUrl: documentUrl,
          recipient: documentRecipient.email ?? documentRecipient.phone,
        },
        hasApprovedKnowledge,
        risk: "high",
      })
    : null;
  if (documentDecision) policyDecisions.push(documentDecision);

  const modelBlockedForKnowledge =
    customerFacing &&
    controls.strictKnowledge &&
    !hasApprovedKnowledge &&
    !meetingContext?.slots.length;
  const policyBlockedReply = (violations?: BotPolicyViolation[]) => ({
    external: false,
    model: "policy-block",
    provider: "policy",
    reason: violations?.length ? violations.map((violation) => violation.id).join(",") : "approved_knowledge_required",
    text: buildSafeBotReply({
      controls: controls.killSwitch ? controls : undefined,
      hasApprovedKnowledge: !modelBlockedForKnowledge,
      language,
      violations,
    }),
  });
  const modelReply = controls.killSwitch
    ? {
        external: false,
        model: "policy-block",
        provider: "policy",
        reason: "kill_switch_active",
        text: buildSafeBotReply({ controls, language }),
      }
    : promptViolations.length
      ? policyBlockedReply(promptViolations)
      : modelBlockedForKnowledge
        ? policyBlockedReply()
        : await generateModelReply({
        knowledgeContext,
        knowledgeTitles: knowledgeSources.map((source) => source.title),
        language,
        messages: modelHistory,
        model,
        prompt,
        qualificationSummary: "summary" in qualification ? qualification.summary : undefined,
        system:
          language === "de"
            ? "Du bist ein autonomer Omnichannel-CRM-Assistent für Webchat, WhatsApp, Instagram, Messenger und E-Mail. Antworte knapp und professionell. Nutze nur den freigegebenen Wissenskontext. Wenn keine freigegebene Quelle vorhanden ist, nenne keine projektspezifischen Fakten. Keine Internetrecherche. Keine garantierten Renditen, Finanzierungszusagen, Preisgarantien oder verbindliche Rechts-/Steuerberatung. Kundendaten dürfen nach Policy automatisch gespeichert werden. Dokumente und Termine nur nach den harten Novalure-Policy-Regeln ausführen."
            : "You are an autonomous omnichannel CRM assistant for Webchat, WhatsApp, Instagram, Messenger and email. Reply concisely and professionally. Use only approved knowledge context. If no approved source is available, do not state project-specific facts. Do not browse the internet. Do not promise guaranteed returns, financing approval, price guarantees, or binding legal/tax advice. Customer data can be saved automatically under policy. Documents and appointments may run only under the hard Novalure policy rules.",
      });
  const meetingReply = wantsMeeting
    ? buildMeetingReply({
        booking: meetingBooking,
        bookingDecision: meetingBookingDecision,
        context: meetingContext,
        language,
        meetingPayload,
      })
    : null;
  const safeReply = sanitizeBotReply({
    controls,
    customerFacing,
    hasApprovedKnowledge,
    hasOperationalContext: Boolean(meetingReply || meetingContext?.slots.length),
    language,
    prompt,
    text: meetingReply ?? modelReply.text,
  });
  const finalReplyText = safeReply.blocked
    ? safeReply.text
    : appendRequiredCitations({
        language,
        sources: knowledgeSources,
        text: safeReply.text,
      });
  const requiresHumanHandoff = Boolean(
    customerFacing &&
      controls.strictKnowledge &&
      (modelBlockedForKnowledge || (safeReply.blocked && !hasApprovedKnowledge && !meetingContext?.slots.length)),
  );
  const handoffReason = requiresHumanHandoff
    ? modelBlockedForKnowledge
      ? "approved_knowledge_required"
      : "policy_safe_reply"
    : null;
  const modelDecision = evaluateBotAction({
    action: "model_reply",
    controls,
    hasApprovedKnowledge,
    risk: "medium",
  });
  policyDecisions.push(modelDecision);
  const channelDecision = evaluateBotAction({
    action: "channel_reply",
    controls,
    hasApprovedKnowledge,
    risk: "medium",
  });
  policyDecisions.push(channelDecision);

  const knowledgeToolCallId = await insertBotToolCall({
    session,
    botId,
    conversationId,
    input: { query: prompt },
    output: knowledge,
    riskLevel: "low",
    toolName: "search_approved_knowledge",
  });
  const qualificationToolCallId = await insertBotToolCall({
    session,
    botId,
    conversationId,
    input: { budget: payload.budget, prompt, timeline: payload.timeline },
    output: qualification,
    riskLevel: "medium",
    toolName: "qualify_lead",
  });
  const customerDataToolCallId = await insertBotToolCall({
    session,
    botId,
    conversationId,
    input: { channel, consent: payload.consent, email: payload.email, name: payload.name, phone: payload.phone },
    output: {
      ...customerData,
      crmDecision,
      crmSync,
    },
    riskLevel: "medium",
    toolName: "capture_customer_data",
  });
  const meetingToolCallId = meetingSlots
    ? await insertBotToolCall({
        session,
        botId,
        conversationId,
        input: { meetingPage: meetingContext?.slug ?? payload.meetingPage, prompt, selectedDate: meetingPayload.selectedDate, slot: meetingPayload.slot },
        output: {
          booking: meetingBooking,
          bookingUrl: meetingContext?.bookingUrl ?? null,
          decision: meetingBookingDecision ?? meetingPrepareDecision,
          pageTitle: meetingContext?.page?.title ?? null,
          slots: meetingSlots,
        },
        requiresApproval: false,
        riskLevel: "medium",
        status: meetingPrepareDecision?.allowed === false ? "failed" : "completed",
        toolName: "find_meeting_slots",
      })
    : null;
  const recordedDocumentDelivery = documentDecision
    ? await recordDocumentDelivery({
        asset: documentAsset,
        botId,
        channel,
        contactId,
        conversationId,
        customerData,
        decision: documentDecision,
        documentName: asOptionalString(payload.documentName) ?? "Freigegebenes Dokument",
        documentUrl,
        payload,
        session,
      })
    : null;
  const documentToolCallId = documentSend
    ? await insertBotToolCall({
        session,
        botId,
        conversationId,
        input: { channel, documentId: payload.documentId, mediaAssetId: payload.mediaAssetId },
        output: {
          ...documentSend,
          decision: documentDecision,
          delivery: recordedDocumentDelivery?.delivery ?? null,
          documentSendId: recordedDocumentDelivery?.documentSendId ?? null,
        },
        requiresApproval: false,
        riskLevel: "high",
        status: documentDecision?.allowed === false ? "failed" : "completed",
        toolName: "send_document",
      })
    : null;
  const requestedActions = {
    document: Boolean(documentSend),
    meeting: Boolean(meetingSlots),
  };
  const score = "score" in qualification && typeof qualification.score === "number" ? qualification.score : null;
  const nextAction = requiresHumanHandoff
    ? language === "de"
      ? "Anfrage an das Team uebergeben: keine freigegebene Wissensquelle gefunden"
      : "Hand the enquiry to the team: no approved knowledge source found"
    : documentDecision
      ? documentDecision.mode === "block"
      ? language === "de"
        ? "Dokumentversand durch Policy blockiert"
        : "Document delivery blocked by policy"
      : language === "de"
        ? "Dokumentversand autonom verarbeitet"
        : "Document delivery handled autonomously"
    : meetingBookingDecision
      ? meetingBookingDecision.mode === "block"
        ? language === "de"
          ? "Terminbuchung durch Policy blockiert"
          : "Meeting booking blocked by policy"
        : language === "de"
          ? "Terminbuchung autonom verarbeitet"
          : "Meeting booking handled autonomously"
      : meetingSlots
        ? language === "de"
          ? "Terminvorschlaege nach Regeln vorbereitet"
          : "Prepare meeting slot suggestions under policy"
        : "stage" in qualification && qualification.stage === "qualified"
          ? language === "de"
            ? "Lead qualifiziert und nächsten Schritt automatisch vorbereiten"
            : "Qualify lead and prepare next step automatically"
          : language === "de"
            ? "Antwort senden und bei Bedarf nachfassen"
            : "Reply and follow up if needed";
  const approvalId = controls.requireHumanApproval && !controls.killSwitch
    ? await createApprovalRequest({
        session,
        action: "bot.write_actions.manual_override",
        entityId: conversationId,
        entityType: "bot_conversation",
        payload: {
          botName,
          channel,
          controls,
          decisions: policyDecisions,
          prompt,
          qualification,
          requestedActions,
          toolCallIds: [knowledgeToolCallId, qualificationToolCallId, customerDataToolCallId, meetingToolCallId, documentToolCallId].filter(Boolean),
        },
        projectId,
        summary:
          language === "de"
            ? "Manuelle Bot-Kontrolle ist per Umgebungswert aktiv"
            : "Manual bot control is enabled by environment",
      })
    : null;
  const runSummary = {
    approvalId,
    documentRequested: requestedActions.document,
    humanHandoffRequired: requiresHumanHandoff,
    humanApprovalRequired: Boolean(approvalId),
    meetingRequested: requestedActions.meeting,
    nextAction,
    score,
  };
  const pendingMeetingForNextReply =
    meetingContext && !meetingBooking?.persisted && meetingPayload.selectedDate && meetingPayload.slot
      ? {
          calendarProvider: meetingPayload.calendarProvider,
          meetingProvider: meetingPayload.meetingProvider,
          selectedDate: meetingPayload.selectedDate,
          slot: meetingPayload.slot,
          slug: meetingPayload.slug,
        }
      : null;

  await insertBotMessage({
    session,
    conversationId,
    content: finalReplyText,
    metadata: {
      autonomy: {
        controls,
        customerFacing,
        decisions: policyDecisions,
        documentDelivery: recordedDocumentDelivery?.delivery ?? null,
        meetingBooking,
        promptViolations,
        replyBlocked: safeReply.blocked,
      },
      botRunSummary: runSummary,
      external: modelReply.external,
      pendingMeeting: pendingMeetingForNextReply,
      provider: modelReply.provider,
      reason: modelReply.reason ?? null,
      requestedActions,
    },
    model: modelReply.model,
    role: "assistant",
  });

  if (requiresHumanHandoff) {
    await updateBotConversationStatus({
      session,
      conversationId,
      status: "handoff",
      metadata: {
        handoff: {
          at: new Date().toISOString(),
          reason: handoffReason,
          sourceCount: knowledgeSources.length,
        },
      },
    });
  }

  await writeAuditLog({
    session,
    action: "bot.autonomy.decision",
    after: {
      approvalId,
      botName,
      channel,
      controls,
      customerFacing,
      crmDecision,
      crmSync,
      decisions: policyDecisions,
      documentDelivery: recordedDocumentDelivery?.delivery ?? null,
      documentSendId: recordedDocumentDelivery?.documentSendId ?? null,
      knowledgeSourceCount: knowledgeSources.length,
      meetingBooking,
      model: modelReply.model,
      promptViolations,
      provider: modelReply.provider,
      replyBlocked: safeReply.blocked,
      runSummary,
    },
    entityId: conversationId,
    entityType: "bot_conversation",
  });

  return {
    approvalId,
    autonomy: {
      controls,
      decisions: policyDecisions,
      documentDelivery: recordedDocumentDelivery?.delivery ?? null,
      meetingBooking,
      replyBlocked: safeReply.blocked,
    },
    botName,
    conversationId,
    externalModelCall: modelReply.external,
    humanApprovalRequired: Boolean(approvalId),
    message: {
      content: finalReplyText,
      role: "assistant" as const,
    },
    model: modelReply.model,
    persisted: Boolean(knowledgeToolCallId || qualificationToolCallId),
    provider: modelReply.provider,
    providerStatus: getModelProviderStatus(),
    runSummary,
    toolResults: [knowledge, qualification, customerData, meetingSlots, documentSend, meetingBooking, recordedDocumentDelivery?.delivery].filter(Boolean),
  } satisfies BotChatRunResult;
}
