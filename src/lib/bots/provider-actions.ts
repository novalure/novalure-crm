import { sendNewsletterEmail } from "@/lib/integrations/resend";
import type { BotChannelAccountCredentials } from "@/lib/db/runtime-repositories";

export type BotDocumentDeliveryResult = {
  deliveryMode: "email" | "whatsapp";
  error?: string | null;
  messageId?: string | null;
  provider: "resend" | "mock" | "whatsapp-cloud" | "whatsapp-mock";
  recipient: string | null;
  status: "failed" | "queued" | "sent";
};

export type BotChannelReplyDeliveryResult = {
  deliveryMode: "instagram" | "messenger" | "mock" | "whatsapp";
  error?: string | null;
  messageId?: string | null;
  provider: "instagram-graph" | "instagram-mock" | "messenger-graph" | "messenger-mock" | "mock" | "whatsapp-cloud" | "whatsapp-mock";
  recipient: string | null;
  status: "blocked" | "failed" | "queued" | "sent";
};

type SendBotDocumentInput = {
  channel: string;
  documentName: string;
  documentUrl: string | null;
  idempotencyKey: string;
  mediaMimeType?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
};

type SendBotChannelReplyInput = {
  accountRef?: string | null;
  channel: string;
  credentials?: BotChannelAccountCredentials | null;
  idempotencyKey: string;
  message: string;
  recipientPhone?: string | null;
  testMode?: boolean;
};

function envValue(name: string) {
  return process.env[name]?.trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizePhone(value?: string | null) {
  const phone = value?.trim();
  if (!phone) return null;

  const normalized = phone.replace(/^00/, "").replace(/[^0-9]/g, "");
  return normalized.length >= 8 ? normalized : null;
}

function wantsWhatsApp(channel: string) {
  return channel.toLowerCase().includes("whatsapp");
}

function wantsInstagram(channel: string) {
  return channel.toLowerCase().includes("instagram");
}

function wantsMessenger(channel: string) {
  return channel.toLowerCase().includes("messenger") || channel.toLowerCase().includes("facebook");
}

function getWhatsAppProviderError(
  error: { code?: number; error_subcode?: number; message?: string; type?: string } | undefined,
  status: number,
) {
  const message = error?.message?.trim();
  const normalized = message?.toLowerCase() ?? "";

  if (
    status === 401 ||
    error?.code === 190 ||
    normalized.includes("authentication") ||
    normalized.includes("access token") ||
    normalized.includes("oauth")
  ) {
    return "WhatsApp access token is invalid or expired. Generate a new token in Meta and update META_WHATSAPP_ACCESS_TOKEN in Vercel.";
  }

  if (status === 403 || normalized.includes("permission")) {
    return "WhatsApp token does not have permission to send this message or is not linked to this phone number.";
  }

  return message || `WhatsApp returned ${status}`;
}

function getMetaMessagingProviderError(
  channel: "Instagram" | "Facebook Messenger",
  error: { code?: number; error_subcode?: number; message?: string; type?: string } | undefined,
  status: number,
) {
  const message = error?.message?.trim();
  const normalized = message?.toLowerCase() ?? "";
  const label = channel === "Instagram" ? "Instagram" : "Facebook Messenger";

  if (
    status === 401 ||
    error?.code === 190 ||
    normalized.includes("authentication") ||
    normalized.includes("access token") ||
    normalized.includes("oauth")
  ) {
    return `${label} page access token is invalid or expired. Update the Meta page token in Vercel.`;
  }

  if (status === 403 || normalized.includes("permission")) {
    return `${label} token does not have permission to send messages. Check Meta app review, Page access and messaging permissions.`;
  }

  return message || `${label} returned ${status}`;
}

function buildDocumentEmail(input: SendBotDocumentInput) {
  const contactName = input.recipientName?.trim() || "Guten Tag";
  const safeDocumentName = escapeHtml(input.documentName);
  const safeContactName = escapeHtml(contactName);
  const safeUrl = input.documentUrl ? escapeHtml(input.documentUrl) : "";

  return {
    html: [
      `<p>${safeContactName},</p>`,
      `<p>hier ist das angefragte Dokument: <strong>${safeDocumentName}</strong>.</p>`,
      safeUrl
        ? `<p><a href="${safeUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;padding:10px 14px;border-radius:8px;text-decoration:none;">Dokument öffnen</a></p>`
        : `<p>Das Dokument wurde freigegeben und wird vom Team bereitgestellt.</p>`,
      `<p>Viele Gruesse<br>Novalure CRM</p>`,
    ].join(""),
    subject: `Ihr angefragtes Dokument: ${input.documentName}`,
  };
}

async function sendWhatsAppDocument(input: SendBotDocumentInput): Promise<BotDocumentDeliveryResult> {
  const accessToken = envValue("META_WHATSAPP_ACCESS_TOKEN") || envValue("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = envValue("META_WHATSAPP_PHONE_NUMBER_ID") || envValue("WHATSAPP_PHONE_NUMBER_ID");
  const graphVersion = envValue("META_GRAPH_API_VERSION") || "v23.0";
  const recipient = normalizePhone(input.recipientPhone);

  if (!recipient) {
    return {
      deliveryMode: "whatsapp",
      error: "No valid WhatsApp recipient phone number is available.",
      provider: "whatsapp-mock",
      recipient: null,
      status: "failed",
    };
  }

  if (!accessToken || !phoneNumberId) {
    return {
      deliveryMode: "whatsapp",
      error: "META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID are not configured.",
      provider: "whatsapp-mock",
      recipient,
      status: "queued",
    };
  }

  if (!input.documentUrl) {
    return {
      deliveryMode: "whatsapp",
      error: "No public document URL is available for WhatsApp delivery.",
      provider: "whatsapp-cloud",
      recipient,
      status: "failed",
    };
  }

  try {
    const mediaType = input.mediaMimeType?.toLowerCase().startsWith("image/") ? "image" : "document";
    const mediaPayload =
      mediaType === "image"
        ? {
            image: {
              caption: input.documentName,
              link: input.documentUrl,
            },
            type: "image",
          }
        : {
            document: {
              caption: input.documentName,
              filename: input.documentName,
              link: input.documentUrl,
            },
            type: "document",
          };
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      body: JSON.stringify({
        ...mediaPayload,
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { code?: number; error_subcode?: number; message?: string; type?: string };
      messages?: Array<{ id?: string }>;
    };

    if (!response.ok) {
      return {
        deliveryMode: "whatsapp",
        error: getWhatsAppProviderError(data.error, response.status),
        messageId: data.messages?.[0]?.id ?? null,
        provider: "whatsapp-cloud",
        recipient,
        status: "failed",
      };
    }

    return {
      deliveryMode: "whatsapp",
      messageId: data.messages?.[0]?.id ?? null,
      provider: "whatsapp-cloud",
      recipient,
      status: "sent",
    };
  } catch (error) {
    return {
      deliveryMode: "whatsapp",
      error: error instanceof Error ? error.message : "WhatsApp request failed",
      provider: "whatsapp-cloud",
      recipient,
      status: "failed",
    };
  }
}

async function sendWhatsAppText(input: SendBotChannelReplyInput): Promise<BotChannelReplyDeliveryResult> {
  const accessToken =
    input.credentials?.accessToken ||
    envValue("META_WHATSAPP_ACCESS_TOKEN") ||
    envValue("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId =
    input.accountRef?.trim() ||
    input.credentials?.phoneNumberId ||
    envValue("META_WHATSAPP_PHONE_NUMBER_ID") ||
    envValue("WHATSAPP_PHONE_NUMBER_ID");
  const graphVersion = input.credentials?.graphVersion || envValue("META_GRAPH_API_VERSION") || "v23.0";
  const recipient = normalizePhone(input.recipientPhone);
  const message = input.message.trim();

  if (!recipient) {
    return {
      deliveryMode: "whatsapp",
      error: "No valid WhatsApp recipient phone number is available.",
      provider: "whatsapp-mock",
      recipient: null,
      status: "failed",
    };
  }

  if (!message) {
    return {
      deliveryMode: "whatsapp",
      error: "No outbound bot message is available.",
      provider: "whatsapp-mock",
      recipient,
      status: "blocked",
    };
  }

  if (input.testMode) {
    return {
      deliveryMode: "whatsapp",
      error: "NOVALURE_BOT_TEST_MODE is active. WhatsApp reply was not sent.",
      provider: "whatsapp-mock",
      recipient,
      status: "queued",
    };
  }

  if (!accessToken || !phoneNumberId) {
    return {
      deliveryMode: "whatsapp",
      error: "META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID are not configured.",
      provider: "whatsapp-mock",
      recipient,
      status: "queued",
    };
  }

  try {
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        text: {
          body: message.slice(0, 4096),
          preview_url: false,
        },
        to: recipient,
        type: "text",
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { code?: number; error_subcode?: number; message?: string; type?: string };
      messages?: Array<{ id?: string }>;
    };

    if (!response.ok) {
      return {
        deliveryMode: "whatsapp",
        error: getWhatsAppProviderError(data.error, response.status),
        messageId: data.messages?.[0]?.id ?? null,
        provider: "whatsapp-cloud",
        recipient,
        status: "failed",
      };
    }

    return {
      deliveryMode: "whatsapp",
      messageId: data.messages?.[0]?.id ?? null,
      provider: "whatsapp-cloud",
      recipient,
      status: "sent",
    };
  } catch (error) {
    return {
      deliveryMode: "whatsapp",
      error: error instanceof Error ? error.message : "WhatsApp request failed",
      provider: "whatsapp-cloud",
      recipient,
      status: "failed",
    };
  }
}

async function sendMetaMessagingText(
  input: SendBotChannelReplyInput,
  channel: "Instagram" | "Facebook Messenger",
): Promise<BotChannelReplyDeliveryResult> {
  const graphVersion = input.credentials?.graphVersion || envValue("META_GRAPH_API_VERSION") || "v23.0";
  const channelIsInstagram = channel === "Instagram";
  const accessToken = channelIsInstagram
    ? input.credentials?.accessToken ||
      envValue("META_INSTAGRAM_PAGE_ACCESS_TOKEN") ||
      envValue("META_INSTAGRAM_ACCESS_TOKEN") ||
      envValue("META_FACEBOOK_PAGE_ACCESS_TOKEN")
    : input.credentials?.accessToken ||
      envValue("META_MESSENGER_PAGE_ACCESS_TOKEN") ||
      envValue("META_FACEBOOK_PAGE_ACCESS_TOKEN") ||
      envValue("META_PAGE_ACCESS_TOKEN");
  const pageId =
    input.accountRef?.trim() ||
    (channelIsInstagram
      ? input.credentials?.instagramAccountId ||
        input.credentials?.pageId ||
        envValue("META_INSTAGRAM_ACCOUNT_ID") ||
        envValue("META_INSTAGRAM_PAGE_ID") ||
        envValue("META_FACEBOOK_PAGE_ID")
      : input.credentials?.pageId || envValue("META_MESSENGER_PAGE_ID") || envValue("META_FACEBOOK_PAGE_ID"));
  const endpoint =
    channelIsInstagram && (input.credentials?.instagramAccountId || envValue("META_INSTAGRAM_ACCOUNT_ID"))
      ? `https://graph.instagram.com/${graphVersion}/${pageId}/messages`
      : `https://graph.facebook.com/${graphVersion}/${pageId}/messages`;
  const recipient = input.recipientPhone?.trim() || null;
  const message = input.message.trim();
  const deliveryMode = channelIsInstagram ? "instagram" : "messenger";
  const provider = channelIsInstagram ? "instagram-graph" : "messenger-graph";
  const mockProvider = channelIsInstagram ? "instagram-mock" : "messenger-mock";

  if (!recipient) {
    return {
      deliveryMode,
      error: `No ${channel} recipient id is available.`,
      provider: mockProvider,
      recipient: null,
      status: "failed",
    };
  }

  if (!message) {
    return {
      deliveryMode,
      error: "No outbound bot message is available.",
      provider: mockProvider,
      recipient,
      status: "blocked",
    };
  }

  if (input.testMode) {
    return {
      deliveryMode,
      error: "NOVALURE_BOT_TEST_MODE is active. Meta reply was not sent.",
      provider: mockProvider,
      recipient,
      status: "queued",
    };
  }

  if (!accessToken || !pageId) {
    return {
      deliveryMode,
      error: channelIsInstagram
        ? "META_INSTAGRAM_PAGE_ACCESS_TOKEN and META_INSTAGRAM_PAGE_ID or META_INSTAGRAM_ACCOUNT_ID are not configured."
        : "META_MESSENGER_PAGE_ACCESS_TOKEN and META_MESSENGER_PAGE_ID are not configured.",
      provider: mockProvider,
      recipient,
      status: "queued",
    };
  }

  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        ...(channelIsInstagram ? {} : { messaging_type: "RESPONSE" }),
        message: {
          text: message.slice(0, 2000),
        },
        recipient: {
          id: recipient,
        },
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { code?: number; error_subcode?: number; message?: string; type?: string };
      message_id?: string;
      recipient_id?: string;
    };

    if (!response.ok) {
      return {
        deliveryMode,
        error: getMetaMessagingProviderError(channel, data.error, response.status),
        messageId: data.message_id ?? null,
        provider,
        recipient,
        status: "failed",
      };
    }

    return {
      deliveryMode,
      messageId: data.message_id ?? null,
      provider,
      recipient: data.recipient_id ?? recipient,
      status: "sent",
    };
  } catch (error) {
    return {
      deliveryMode,
      error: error instanceof Error ? error.message : `${channel} request failed`,
      provider,
      recipient,
      status: "failed",
    };
  }
}

export async function sendBotDocument(input: SendBotDocumentInput): Promise<BotDocumentDeliveryResult> {
  if (wantsWhatsApp(input.channel) && input.recipientPhone) {
    return sendWhatsAppDocument(input);
  }

  if (!input.recipientEmail?.trim()) {
    if (input.recipientPhone) return sendWhatsAppDocument(input);

    return {
      deliveryMode: "email",
      error: "No email or WhatsApp recipient is available.",
      provider: "mock",
      recipient: null,
      status: "failed",
    };
  }

  const email = buildDocumentEmail(input);
  const result = await sendNewsletterEmail({
    html: email.html,
    idempotencyKey: input.idempotencyKey,
    subject: email.subject,
    to: input.recipientEmail.trim(),
  });

  return {
    deliveryMode: "email",
    error: result.error ?? null,
    messageId: result.messageId ?? null,
    provider: result.provider,
    recipient: input.recipientEmail.trim(),
    status: result.status === "sent" ? "sent" : result.status === "failed" ? "failed" : "queued",
  };
}

export async function sendBotChannelReply(input: SendBotChannelReplyInput): Promise<BotChannelReplyDeliveryResult> {
  if (wantsWhatsApp(input.channel)) {
    return sendWhatsAppText(input);
  }

  if (wantsInstagram(input.channel)) {
    return sendMetaMessagingText(input, "Instagram");
  }

  if (wantsMessenger(input.channel)) {
    return sendMetaMessagingText(input, "Facebook Messenger");
  }

  return {
    deliveryMode: "mock",
    error: "No direct outbound provider is configured for this channel.",
    provider: "mock",
    recipient: input.recipientPhone?.trim() || null,
    status: input.testMode ? "queued" : "queued",
  };
}
