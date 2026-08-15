import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
import { runBotChat } from "@/lib/bots/chat-runtime";
import { normalizeIncomingBotMessage } from "@/lib/bots/omnichannel";
import { readBoolean } from "@/lib/bots/policy";
import { sendBotChannelReply } from "@/lib/bots/provider-actions";
import {
  constantTimeEqualStrings,
  hasSupportedWebhookContentEncoding,
  isJsonWebhookContentType,
  isMetaWebhookPayload,
  readLimitedWebhookBody,
  verifyMetaWebhookSignature,
} from "@/lib/bots/webhook-security";
import { evaluateOutboundConsent, type ConsentPolicyChannel } from "@/lib/db/consent-policy";
import {
  findBotChannelAccountForWebhook,
  insertBotChannelWebhook,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import type { LanguageCode } from "@/lib/i18n";
import { getProductRoleCapabilities } from "@/lib/product-model";

export const maxDuration = 30;

type ChannelAccountResolution = Awaited<ReturnType<typeof findBotChannelAccountForWebhook>>;
type MappedChannelAccount = Extract<ChannelAccountResolution, { status: "matched" }>["account"];
type SafeProvider = "custom" | "meta" | "unknown";
type SafeMappingStatus = ChannelAccountResolution["status"] | "not_attempted";

function parseJson(rawBody: Buffer) {
  try {
    const decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    return JSON.parse(decodedBody) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createWebhookSession(channelAccount: MappedChannelAccount): AppSession {
  return {
    authenticated: true,
    email: "bot-webhook@novalure.local",
    name: "Novalure Bot Webhook",
    permissions: [],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "assistant",
    source: "database",
    userId: "bot-webhook",
    workspaceId: channelAccount.workspaceId,
    workspaceName: channelAccount.workspaceName ?? "Novalure",
  };
}

function allowUnsignedCustomWebhooks() {
  return process.env.NODE_ENV !== "production" && readBoolean(process.env.NOVALURE_BOT_ALLOW_UNSIGNED_WEBHOOKS) === true;
}

function webhookProcessingDisabled() {
  return [
    process.env.NOVALURE_BOT_WEBHOOK_DISABLED,
    process.env.NOVALURE_BOT_KILL_SWITCH,
    process.env.NOVALURE_BOT_NOT_AUS,
    process.env.NOVALURE_BOT_DISABLED,
  ].some((value) => readBoolean(value) === true);
}

function logWebhookStatus(input: {
  correlationId: string;
  mapping: SafeMappingStatus;
  provider: SafeProvider;
  status: string;
}) {
  console.info("bot_channel_webhook", input);
}

function jsonWebhookResponse(
  correlationId: string,
  status: number,
  body: { accepted: boolean; error?: string } = { accepted: status >= 200 && status < 300 },
) {
  return NextResponse.json(
    { ...body, correlationId },
    {
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": correlationId,
      },
      status,
    },
  );
}

function detectWebhookLanguage(text: string): LanguageCode {
  return /(\b(hallo|ich|termin|besichtigung|unterlage|unterlagen|dokument|expose|exposé|bitte|danke)\b|[äöüß])/i.test(text)
    ? "de"
    : "en";
}

function getConsentChannel(channel: string): ConsentPolicyChannel {
  const normalized = channel.toLowerCase();
  if (normalized.includes("whatsapp")) return "WhatsApp";
  if (normalized.includes("instagram") || normalized.includes("messenger") || normalized.includes("facebook")) return "Instagram";
  return "E-Mail";
}

export async function GET(request: Request) {
  const correlationId = randomUUID();
  const url = new URL(request.url);
  const challenge =
    url.searchParams.get("hub.challenge") ||
    url.searchParams.get("challenge") ||
    url.searchParams.get("crc_token");
  const token = url.searchParams.get("hub.verify_token") || url.searchParams.get("verify_token");
  const expectedToken = process.env.NOVALURE_BOT_WEBHOOK_VERIFY_TOKEN?.trim();
  const mode = url.searchParams.get("hub.mode");

  if (!challenge || !token || (mode && mode !== "subscribe")) {
    logWebhookStatus({ correlationId, mapping: "not_attempted", provider: "meta", status: "verification_rejected" });
    return jsonWebhookResponse(correlationId, 400, { accepted: false, error: "invalid_verification_request" });
  }

  if (!expectedToken) {
    logWebhookStatus({ correlationId, mapping: "not_attempted", provider: "meta", status: "verification_unavailable" });
    return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "verification_unavailable" });
  }

  if (!constantTimeEqualStrings(token, expectedToken)) {
    logWebhookStatus({ correlationId, mapping: "not_attempted", provider: "meta", status: "verification_rejected" });
    return jsonWebhookResponse(correlationId, 403, { accepted: false, error: "verification_rejected" });
  }

  logWebhookStatus({ correlationId, mapping: "not_attempted", provider: "meta", status: "verification_accepted" });
  return new Response(challenge, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-correlation-id": correlationId,
    },
    status: 200,
  });
}

export async function POST(request: Request) {
  const correlationId = randomUUID();
  let mappingStatus: SafeMappingStatus = "not_attempted";
  let provider: SafeProvider = "unknown";

  try {
    if (webhookProcessingDisabled()) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "processing_disabled" });
      return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "webhook_unavailable" });
    }

    if (!isJsonWebhookContentType(request.headers.get("content-type"))) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "content_type_rejected" });
      return jsonWebhookResponse(correlationId, 415, { accepted: false, error: "unsupported_content_type" });
    }

    if (!hasSupportedWebhookContentEncoding(request.headers.get("content-encoding"))) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "content_encoding_rejected" });
      return jsonWebhookResponse(correlationId, 415, { accepted: false, error: "unsupported_content_encoding" });
    }

    const rawBodyResult = await readLimitedWebhookBody(request);
    if (!rawBodyResult.ok) {
      const status = rawBodyResult.reason === "payload_too_large" ? 413 : 400;
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: rawBodyResult.reason });
      return jsonWebhookResponse(correlationId, status, { accepted: false, error: rawBodyResult.reason });
    }

    const body = parseJson(rawBodyResult.body);
    if (!isRecord(body)) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "invalid_json" });
      return jsonWebhookResponse(correlationId, 400, { accepted: false, error: "invalid_json" });
    }

    const metaPayload = isMetaWebhookPayload(body);
    provider = metaPayload ? "meta" : "custom";
    const authorization = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const expectedCustomSecret = process.env.NOVALURE_BOT_WEBHOOK_SECRET?.trim();
    const providedCustomSecret =
      request.headers.get("x-novalure-webhook-secret") ||
      request.headers.get("x-webhook-secret") ||
      authorization;
    const authenticated = metaPayload
      ? verifyMetaWebhookSignature(
          rawBodyResult.body,
          request.headers.get("x-hub-signature-256"),
          process.env.META_APP_SECRET,
        )
      : constantTimeEqualStrings(providedCustomSecret, expectedCustomSecret) || allowUnsignedCustomWebhooks();

    if (!authenticated) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "authentication_rejected" });
      return jsonWebhookResponse(correlationId, 401, { accepted: false, error: "unauthorized" });
    }

    const normalizedMessage = normalizeIncomingBotMessage(body);
    if (!normalizedMessage) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "event_rejected" });
      return jsonWebhookResponse(correlationId, 400, { accepted: false, error: "invalid_event" });
    }

    const channelAccountResolution = await findBotChannelAccountForWebhook({
      accountRef: normalizedMessage.accountRef,
      channel: normalizedMessage.channel,
    });
    mappingStatus = channelAccountResolution.status;

    if (channelAccountResolution.status !== "matched") {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "mapping_rejected" });
      return jsonWebhookResponse(correlationId, 200);
    }

    const channelAccount = channelAccountResolution.account;
    const webhookSession = createWebhookSession(channelAccount);
    const message = {
      ...normalizedMessage,
      accountRef: channelAccount.externalAccountId,
      channel: channelAccount.channel,
    };
    const webhookRecord = await insertBotChannelWebhook({
      workspaceId: webhookSession.workspaceId,
      channelAccountId: channelAccount.id,
      contactRef: message.contactRef,
      eventType: message.eventType,
      externalMessageId: message.externalMessageId,
      normalizedMessage: message,
      payload: body,
      status: message.text ? "routed" : "ignored",
    });

    if (!webhookRecord) {
      throw new Error("webhook_event_not_persisted");
    }

    if (webhookRecord.duplicate) {
      logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "duplicate_ignored" });
      return jsonWebhookResponse(correlationId, 200);
    }

    const webhookEventId = webhookRecord.id;
    const botRun = message.text
      ? await runBotChat({
          language: detectWebhookLanguage(message.text),
          payload: {
            ...body,
            channel: message.channel,
            contactRef: message.contactRef,
            name: message.customerName,
            externalMessageId: message.externalMessageId,
            phone: message.phone,
            prompt: message.text,
            source: "channel_webhook",
            title: `${message.channel}: ${message.contactRef}`,
            webhookEventId,
          },
          requestUrl: request.url,
          session: webhookSession,
        })
      : null;
    const channelReplyDecision = botRun?.autonomy.decisions.find((decision) => decision.action === "channel_reply") ?? null;
    const outboundConsent =
      botRun && message.text && channelReplyDecision?.allowed && channelReplyDecision.mode !== "block"
        ? await evaluateOutboundConsent({
            channel: getConsentChannel(message.channel),
            metadata: {
              channel: message.channel,
              source: "bot_channel_webhook",
              webhookEventId,
            },
            phone: message.phone ?? message.contactRef,
            purpose: "botOutreach",
            session: webhookSession,
          })
        : null;
    const outboundDelivery =
      botRun && message.text && channelReplyDecision?.allowed && channelReplyDecision.mode !== "block" && outboundConsent?.allowed
        ? await sendBotChannelReply({
            accountRef: channelAccount.externalAccountId,
            channel: channelAccount.channel,
            credentials: channelAccount.credentials,
            idempotencyKey: `bot-channel-reply:${webhookEventId}`,
            message: botRun.message.content,
            recipientPhone: message.phone ?? message.contactRef,
            testMode: botRun.autonomy.controls.testMode || channelReplyDecision.mode === "test",
          })
        : outboundConsent && !outboundConsent.allowed
          ? {
              deliveryMode: "mock" as const,
              error: `consent_${outboundConsent.reason}`,
              provider: "mock" as const,
              recipient: message.phone ?? message.contactRef ?? null,
              status: "blocked" as const,
            }
          : null;

    if (botRun) {
      await writeAuditLog({
        session: webhookSession,
        action: "bot.channel_reply.decision",
        entityId: botRun.conversationId,
        entityType: "bot_conversation",
        after: {
          channelReplyDecision,
          outboundConsent: outboundConsent
            ? {
                allowed: outboundConsent.allowed,
                channel: outboundConsent.channel,
                purpose: outboundConsent.purpose,
                reason: outboundConsent.reason,
              }
            : null,
          outboundDelivery: outboundDelivery
            ? {
                deliveryMode: outboundDelivery.deliveryMode,
                provider: outboundDelivery.provider,
                status: outboundDelivery.status,
              }
            : null,
          webhookEventId,
        },
      });
    }

    logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "processed" });
    return jsonWebhookResponse(correlationId, 200);
  } catch {
    logWebhookStatus({ correlationId, mapping: mappingStatus, provider, status: "processing_error" });
    return jsonWebhookResponse(correlationId, 500, { accepted: false, error: "processing_failed" });
  }
}
