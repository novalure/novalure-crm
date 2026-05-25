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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstRecord(value: unknown) {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : null;
}

function firstString(value: unknown) {
  return Array.isArray(value) && typeof value[0] === "string" && value[0].trim() ? value[0].trim() : null;
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

function normalizeMetaWhatsAppValue(value: Record<string, unknown>): NormalizedBotMessage | null {
  const message = firstRecord(value.messages);
  const status = firstRecord(value.statuses);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const contact = firstRecord(value.contacts);
  const profile = contact && isRecord(contact.profile) ? contact.profile : {};
  const phone =
    getString(message?.from) ??
    getString(status?.recipient_id) ??
    getString(contact?.wa_id);
  const timestamp = getString(message?.timestamp) ?? getString(status?.timestamp);
  const receivedAt = timestamp && Number.isFinite(Number(timestamp))
    ? new Date(Number(timestamp) * 1000).toISOString()
    : new Date().toISOString();

  if (message) {
    return {
      accountRef: getString(metadata.phone_number_id),
      channel: "WhatsApp",
      contactRef: phone ?? "anonymous",
      customerName: getString(profile.name),
      eventType: "message",
      externalMessageId: getString(message.id) ?? crypto.randomUUID(),
      phone,
      receivedAt,
      text: getMetaMessageText(message),
    };
  }

  if (status) {
    return {
      accountRef: getString(metadata.phone_number_id),
      channel: "WhatsApp",
      contactRef: phone ?? "anonymous",
      customerName: null,
      eventType: getString(status.status) ?? "status",
      externalMessageId: getString(status.id) ?? crypto.randomUUID(),
      phone,
      receivedAt,
      text: "",
    };
  }

  return null;
}

function normalizeMetaWhatsAppMessage(input: Record<string, unknown>): NormalizedBotMessage | null {
  if (input.field === "messages" && isRecord(input.value)) {
    return normalizeMetaWhatsAppValue(input.value);
  }

  if (!Array.isArray(input.entry)) return null;

  for (const entry of input.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;

      const normalized = normalizeMetaWhatsAppValue(change.value);
      if (normalized) return normalized;
    }
  }

  return null;
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

  if (!channel || !senderId) return null;

  const externalMessageId =
    getString(message?.mid) ??
    getString(postback?.mid) ??
    firstString(delivery?.mids) ??
    getString(read?.watermark) ??
    crypto.randomUUID();
  const eventType = message
    ? "message"
    : postback
      ? "postback"
      : delivery
        ? "delivery"
        : read
          ? "read"
          : "event";

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

function normalizeMetaMessagingMessage(input: Record<string, unknown>): NormalizedBotMessage | null {
  if (!normalizeMetaMessagingChannel(input) || !Array.isArray(input.entry)) return null;

  for (const entry of input.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.messaging)) continue;

    for (const event of entry.messaging) {
      if (!isRecord(event)) continue;

      const normalized = normalizeMetaMessagingEvent(input, event, entry);
      if (normalized) return normalized;
    }
  }

  return null;
}

export function normalizeIncomingBotMessage(input: {
  accountRef?: unknown;
  channel?: unknown;
  contactRef?: unknown;
  eventType?: unknown;
  name?: unknown;
  externalMessageId?: unknown;
  payload?: unknown;
  phone?: unknown;
  text?: unknown;
}): NormalizedBotMessage {
  const metaPayload = input as Record<string, unknown>;
  const metaMessage = normalizeMetaWhatsAppMessage(metaPayload) ?? normalizeMetaMessagingMessage(metaPayload);

  if (metaMessage) return metaMessage;

  const payload = isRecord(input.payload)
    ? input.payload
    : {};
  const payloadText = payload.text ?? payload.message ?? payload.body;

  return {
    accountRef: getString(input.accountRef),
    channel: typeof input.channel === "string" ? input.channel : "API/Webhook",
    contactRef: typeof input.contactRef === "string"
      ? input.contactRef
      : typeof input.accountRef === "string"
        ? input.accountRef
        : "anonymous",
    customerName: getString(input.name) ?? getString(payload.name),
    eventType: typeof input.eventType === "string" ? input.eventType : "message",
    externalMessageId: typeof input.externalMessageId === "string" ? input.externalMessageId : crypto.randomUUID(),
    phone: getString(input.phone) ?? getString(payload.phone),
    receivedAt: new Date().toISOString(),
    text: typeof input.text === "string" ? input.text : typeof payloadText === "string" ? payloadText : "",
  };
}
