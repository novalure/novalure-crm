import type { CrmBotChannelConfig } from "@/lib/crm-types";

export const botSelfServeSetup = [
  { id: "goal", label: "Ziel und Rolle festlegen", owner: "customer" },
  { id: "channels", label: "Kanäle verbinden", owner: "customer" },
  { id: "knowledge", label: "Wissen freigeben", owner: "admin" },
  { id: "actions", label: "Aktionen erlauben", owner: "admin" },
  { id: "test", label: "Testgespräche prüfen", owner: "team" },
  { id: "publish", label: "Bot veröffentlichen", owner: "team" },
] as const;

export const botChannelConnectors: Array<{
  channel: CrmBotChannelConfig["channel"];
  complianceNote: string;
  inboundMode: string;
  outboundMode: string;
  provider: string;
  setupSteps: string[];
  webhookPath: string;
}> = [
  {
    channel: "Webchat",
    complianceNote: "Domain-Allowlist, Consent und Widget-Tracking im CRM prüfen.",
    inboundMode: "Novalure Widget Event",
    outboundMode: "Streaming Chat-Antwort",
    provider: "Novalure Webchat",
    setupSteps: ["Widget-Code kopieren", "Domain freigeben", "Testnachricht senden"],
    webhookPath: "/api/bots/chat",
  },
  {
    channel: "WhatsApp",
    complianceNote: "24h Servicefenster beachten; ausserhalb nur freigegebene Templates.",
    inboundMode: "Meta WhatsApp Webhook",
    outboundMode: "24h Antwort oder Template",
    provider: "WhatsApp Business Platform",
    setupSteps: ["Business-Konto verbinden", "Webhook verifizieren", "Templates hinterlegen"],
    webhookPath: "/api/bots/channels/webhook",
  },
  {
    channel: "Instagram",
    complianceNote: "Instagram Business Account, Messaging-Opt-in und Human-Handoff beachten.",
    inboundMode: "Instagram Messaging Webhook",
    outboundMode: "Instagram DM Antwort",
    provider: "Instagram Messaging API",
    setupSteps: ["Instagram Business verbinden", "Webhook abonnieren", "Handoff testen"],
    webhookPath: "/api/bots/channels/webhook",
  },
  {
    channel: "Facebook Messenger",
    complianceNote: "Page-Verbindung, Messaging-Regeln und Eskalation an Menschen prüfen.",
    inboundMode: "Messenger Webhook",
    outboundMode: "Messenger Antwort",
    provider: "Messenger Platform",
    setupSteps: ["Facebook Page verbinden", "Webhook abonnieren", "Inbox-Handoff testen"],
    webhookPath: "/api/bots/channels/webhook",
  },
  {
    channel: "E-Mail",
    complianceNote: "Outbound nur mit Absender, Opt-in und Freigabe bei sensiblen Inhalten.",
    inboundMode: "CRM Inbox",
    outboundMode: "Freigabe-Entwurf",
    provider: "CRM Mailbox",
    setupSteps: ["Absender verbinden", "Routing-Team setzen", "Antwortentwurf testen"],
    webhookPath: "/api/bots/channels/webhook",
  },
  {
    channel: "API/Webhook",
    complianceNote: "Webhook-Secret setzen und Payloads serverseitig validieren.",
    inboundMode: "Signed POST Payload",
    outboundMode: "Webhook Callback",
    provider: "Novalure Webhook",
    setupSteps: ["Endpoint kopieren", "Secret setzen", "Testpayload senden"],
    webhookPath: "/api/bots/channels/webhook",
  },
];

export type NormalizedBotMessage = {
  accountRef?: string | null;
  channel: string;
  contactRef: string;
  customerName?: string | null;
  eventType: string;
  externalMessageId: string;
  phone?: string | null;
  receivedAt: string;
  text: string;
};

type IncomingBotMessageInput = {
  accountRef?: unknown;
  channel?: unknown;
  contactRef?: unknown;
  eventType?: unknown;
  name?: unknown;
  externalMessageId?: unknown;
  payload?: unknown;
  phone?: unknown;
  text?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function records(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.map(getString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function firstRecord(value: unknown) {
  return records(value)[0] ?? null;
}

function toIsoTimestamp(value: unknown) {
  const raw = typeof value === "number" ? String(value) : getString(value);
  const timestamp = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;

  if (!timestamp) return new Date().toISOString();

  return new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000).toISOString();
}

function getMetaMessageText(message: Record<string, unknown>) {
  const type = getString(message.type);

  if (type === "text" && isRecord(message.text)) {
    return getString(message.text.body) ?? "";
  }

  if (type === "button" && isRecord(message.button)) {
    return getString(message.button.text) ?? getString(message.button.payload) ?? "";
  }

  if (type === "interactive" && isRecord(message.interactive)) {
    const buttonReply = isRecord(message.interactive.button_reply) ? message.interactive.button_reply : null;
    const listReply = isRecord(message.interactive.list_reply) ? message.interactive.list_reply : null;

    return (
      getString(buttonReply?.title) ??
      getString(buttonReply?.id) ??
      getString(listReply?.title) ??
      getString(listReply?.id) ??
      ""
    );
  }

  if (type === "document" && isRecord(message.document)) {
    return getString(message.document.filename) ?? getString(message.document.caption) ?? "Dokument empfangen";
  }

  if (type === "image" && isRecord(message.image)) {
    return getString(message.image.caption) ?? "Bild empfangen";
  }

  return "";
}

function getMetaMessagingEventText(event: Record<string, unknown>) {
  const message = isRecord(event.message) ? event.message : null;
  const postback = isRecord(event.postback) ? event.postback : null;

  if (message) {
    const text = getString(message.text);
    if (text) return text;

    const attachment = firstRecord(message.attachments);
    const type = getString(attachment?.type);
    if (type) return `${type} empfangen`;
  }

  return getString(postback?.title) ?? getString(postback?.payload) ?? "";
}

function normalizeMetaWhatsAppValue(value: Record<string, unknown>): NormalizedBotMessage[] {
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const accountRef = getString(metadata.phone_number_id);
  if (!accountRef) return [];

  const contacts = records(value.contacts);
  const messages = records(value.messages).flatMap((message): NormalizedBotMessage[] => {
    const externalMessageId = getString(message.id);
    if (!externalMessageId) return [];

    const messagePhone = getString(message.from);
    const contact = contacts.find((candidate) => getString(candidate.wa_id) === messagePhone) ?? contacts[0] ?? null;
    const profile = contact && isRecord(contact.profile) ? contact.profile : {};
    const phone = messagePhone ?? getString(contact?.wa_id);

    return [{
      accountRef,
      channel: "WhatsApp",
      contactRef: phone ?? "anonymous",
      customerName: getString(profile.name),
      eventType: "message",
      externalMessageId,
      phone,
      receivedAt: toIsoTimestamp(message.timestamp),
      text: getMetaMessageText(message),
    }];
  });

  const statuses = records(value.statuses).flatMap((status): NormalizedBotMessage[] => {
    const providerMessageId = getString(status.id);
    if (!providerMessageId) return [];
    const eventType = getString(status.status) ?? "status";
    const timestamp = getString(status.timestamp);
    const phone = getString(status.recipient_id);

    return [{
      accountRef,
      channel: "WhatsApp",
      contactRef: phone ?? "anonymous",
      customerName: null,
      eventType,
      // Status callbacks reuse the outbound provider message id as they move
      // through sent/delivered/read. The event kind and provider timestamp are
      // part of the durable identity so those distinct callbacks cannot fight
      // over the inbound-message claim.
      externalMessageId: `meta-wa-status:${providerMessageId}:${eventType}:${timestamp ?? "unknown"}`,
      phone,
      receivedAt: toIsoTimestamp(timestamp),
      text: "",
    }];
  });

  return [...messages, ...statuses];
}

function normalizeMetaWhatsAppMessages(input: Record<string, unknown>): NormalizedBotMessage[] {
  if (input.field === "messages" && isRecord(input.value)) {
    return normalizeMetaWhatsAppValue(input.value);
  }

  if (!Array.isArray(input.entry)) return [];

  const normalized: NormalizedBotMessage[] = [];
  for (const entry of input.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      normalized.push(...normalizeMetaWhatsAppValue(change.value));
    }
  }

  return normalized;
}

function normalizeMetaMessagingChannel(input: Record<string, unknown>) {
  const object = getString(input.object)?.toLowerCase();

  if (object === "instagram") return "Instagram";
  if (object === "page") return "Facebook Messenger";

  return null;
}

function normalizeMetaMessagingEvent(
  input: Record<string, unknown>,
  event: Record<string, unknown>,
  entry: Record<string, unknown>,
): NormalizedBotMessage | null {
  const channel = normalizeMetaMessagingChannel(input);
  const sender = isRecord(event.sender) ? event.sender : {};
  const recipient = isRecord(event.recipient) ? event.recipient : {};
  const message = isRecord(event.message) ? event.message : null;
  const postback = isRecord(event.postback) ? event.postback : null;
  const delivery = isRecord(event.delivery) ? event.delivery : null;
  const read = isRecord(event.read) ? event.read : null;
  const senderId = getString(sender.id);
  const recipientId = getString(recipient.id) ?? getString(entry.id);
  const timestamp = typeof event.timestamp === "number" ? String(event.timestamp) : getString(event.timestamp);
  const messageId = getString(message?.mid);
  const postbackId = getString(postback?.mid);
  const deliveryMessageIds = Array.from(new Set(strings(delivery?.mids))).sort();
  const deliveryWatermark = getString(delivery?.watermark);
  const readWatermark = getString(read?.watermark);

  if (!channel || !senderId || !recipientId) return null;
  const eventType = message
    ? "message"
    : postback
      ? "postback"
      : delivery
        ? "delivery"
        : read
          ? "read"
          : "event";
  const externalMessageId = messageId
    ?? (postback
      ? postbackId ?? `meta-postback:${senderId}:${timestamp ?? "unknown"}:${getString(postback.payload) ?? "event"}`
      : delivery
        ? `meta-delivery:${deliveryMessageIds.join(",") || "none"}:${deliveryWatermark ?? timestamp ?? "unknown"}`
        : read
          ? `meta-read:${readWatermark ?? "unknown"}:${timestamp ?? "unknown"}`
          : null);

  if (!externalMessageId) return null;

  return {
    accountRef: recipientId,
    channel,
    contactRef: senderId,
    customerName: null,
    eventType,
    externalMessageId,
    phone: null,
    receivedAt: toIsoTimestamp(event.timestamp),
    text: getMetaMessagingEventText(event),
  };
}

function normalizeMetaMessagingMessages(input: Record<string, unknown>): NormalizedBotMessage[] {
  if (!normalizeMetaMessagingChannel(input) || !Array.isArray(input.entry)) return [];

  const normalized: NormalizedBotMessage[] = [];
  for (const entry of input.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.messaging)) continue;

    for (const event of entry.messaging) {
      if (!isRecord(event)) continue;

      const message = normalizeMetaMessagingEvent(input, event, entry);
      if (message) normalized.push(message);
    }
  }

  return normalized;
}

export function normalizeIncomingBotMessages(input: IncomingBotMessageInput): NormalizedBotMessage[] {
  const metaPayload = input as Record<string, unknown>;
  const metaMessages = [
    ...normalizeMetaWhatsAppMessages(metaPayload),
    ...normalizeMetaMessagingMessages(metaPayload),
  ];

  if (metaMessages.length) return metaMessages;

  const payload = isRecord(input.payload)
    ? input.payload
    : {};
  const payloadText = payload.text ?? payload.message ?? payload.body;
  const accountRef = getString(input.accountRef);
  const channel = getString(input.channel);
  const contactRef = getString(input.contactRef) ?? accountRef;
  const externalMessageId = getString(input.externalMessageId);

  if (!accountRef || !channel || !contactRef || !externalMessageId) return [];

  return [{
    accountRef,
    channel,
    contactRef,
    customerName: getString(input.name) ?? getString(payload.name),
    eventType: typeof input.eventType === "string" ? input.eventType : "message",
    externalMessageId,
    phone: getString(input.phone) ?? getString(payload.phone),
    receivedAt: new Date().toISOString(),
    text: typeof input.text === "string" ? input.text : typeof payloadText === "string" ? payloadText : "",
  }];
}

/** @deprecated Use normalizeIncomingBotMessages for webhook request bodies. */
export function normalizeIncomingBotMessage(input: IncomingBotMessageInput): NormalizedBotMessage | null {
  return normalizeIncomingBotMessages(input)[0] ?? null;
}
