import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
import { runBotChat } from "@/lib/bots/chat-runtime";
import { normalizeIncomingBotMessage } from "@/lib/bots/omnichannel";
import { readBoolean } from "@/lib/bots/policy";
import { sendBotChannelReply } from "@/lib/bots/provider-actions";
import { evaluateOutboundConsent, type ConsentPolicyChannel } from "@/lib/db/consent-policy";
import {
  findBotChannelAccountForWebhook,
  getDefaultWorkspaceForWebhook,
  insertBotChannelWebhook,
  isUuid,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import type { LanguageCode } from "@/lib/i18n";
import { getProductRoleCapabilities } from "@/lib/product-model";

export const maxDuration = 30;

function parseJson(rawBody: string) {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMetaWebhookPayload(value: unknown) {
  return isRecord(value) && (Array.isArray(value.entry) || (value.field === "messages" && isRecord(value.value)));
}

function isMetaDashboardFieldProbe(value: unknown) {
  return isRecord(value) && value.field === "messages" && isRecord(value.value) && !Array.isArray(value.entry);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyMetaSignature(rawBody: string, signature: string | null) {
  const appSecret = process.env.META_APP_SECRET?.trim();

  if (!appSecret || !signature?.startsWith("sha256=")) return false;

  const expectedSignature = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return safeEqual(signature, expectedSignature);
}

function allowUnsignedWebhooks() {
  return readBoolean(process.env.NOVALURE_BOT_ALLOW_UNSIGNED_WEBHOOKS) ?? process.env.NODE_ENV !== "production";
}

async function resolveWebhookSession(
  request: Request,
  body: Record<string, unknown>,
  channelAccount?: Awaited<ReturnType<typeof findBotChannelAccountForWebhook>>,
): Promise<AppSession | null> {
  const workspaceIdFromRequest =
    channelAccount?.workspaceId ||
    request.headers.get("x-novalure-workspace-id") ||
    (typeof body.workspaceId === "string" ? body.workspaceId : null) ||
    process.env.NOVALURE_WORKSPACE_ID ||
    null;
  const fallbackWorkspace = isUuid(workspaceIdFromRequest)
    ? { id: workspaceIdFromRequest, name: "Novalure" }
    : await getDefaultWorkspaceForWebhook();
  const workspaceId = fallbackWorkspace?.id ?? workspaceIdFromRequest;
  const resolvedWorkspaceId = typeof workspaceId === "string" && isUuid(workspaceId) ? workspaceId : null;

  if (!resolvedWorkspaceId) return null;

  return {
    authenticated: true,
    email: "bot-webhook@novalure.local",
    name: "Novalure Bot Webhook",
    permissions: [],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "assistant",
    source: "headers",
    userId: "bot-webhook",
    workspaceId: resolvedWorkspaceId,
    workspaceName: channelAccount?.workspaceName ?? fallbackWorkspace?.name ?? "Novalure",
  };
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
  const url = new URL(request.url);
  const challenge =
    url.searchParams.get("hub.challenge") ||
    url.searchParams.get("challenge") ||
    url.searchParams.get("crc_token");
  const token = url.searchParams.get("hub.verify_token") || url.searchParams.get("verify_token");
  const expectedToken = process.env.NOVALURE_BOT_WEBHOOK_VERIFY_TOKEN;

  if (challenge) {
    if (expectedToken && token !== expectedToken) {
      return new Response("Invalid verify token", { status: 403 });
    }

    return new Response(challenge, {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 200,
    });
  }

  return NextResponse.json({
    ok: true,
    supportedChannels: ["Webchat", "WhatsApp", "Instagram", "Facebook Messenger", "E-Mail", "API/Webhook"],
  });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.NOVALURE_BOT_WEBHOOK_SECRET?.trim();
  const providedSecret =
    request.headers.get("x-novalure-webhook-secret") ||
    request.headers.get("x-webhook-secret") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const rawBody = await request.text();
  const body = parseJson(rawBody);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const signature = request.headers.get("x-hub-signature-256");
  const metaSignatureValid = isMetaWebhookPayload(body) ? verifyMetaSignature(rawBody, signature) : false;
  const unsignedMetaDashboardProbe = isMetaDashboardFieldProbe(body) && !signature;
  const customSecretValid = Boolean(expectedSecret && providedSecret && safeEqual(providedSecret, expectedSecret));
  const authenticatedWebhook =
    customSecretValid ||
    metaSignatureValid ||
    unsignedMetaDashboardProbe ||
    (!expectedSecret && allowUnsignedWebhooks());

  if (!authenticatedWebhook) {
    return NextResponse.json({
      error: "Invalid webhook secret or Meta signature",
      hint: "Set NOVALURE_BOT_WEBHOOK_SECRET or META_APP_SECRET. Use NOVALURE_BOT_ALLOW_UNSIGNED_WEBHOOKS=1 only for local tests.",
    }, { status: 401 });
  }

  const message = normalizeIncomingBotMessage(body as Record<string, unknown>);
  const channelAccount = await findBotChannelAccountForWebhook({
    accountRef: message.accountRef,
    channel: message.channel,
  });
  const webhookSession = await resolveWebhookSession(request, body as Record<string, unknown>, channelAccount);
  const webhookRecord = webhookSession
    ? await insertBotChannelWebhook({
        workspaceId: webhookSession.workspaceId,
        channelAccountId: channelAccount?.id ?? null,
        channel: message.channel,
        contactRef: message.contactRef,
        eventType: message.eventType,
        externalMessageId: message.externalMessageId,
        normalizedMessage: message,
        payload: body,
        status: message.text ? "routed" : "ignored",
      })
    : null;
  const webhookEventId = webhookRecord?.id ?? null;
  const duplicateWebhook = Boolean(webhookRecord?.duplicate);

  if (webhookSession && duplicateWebhook) {
    await writeAuditLog({
      session: webhookSession,
      action: "bot.channel_webhook.duplicate_ignored",
      entityId: webhookEventId,
      entityType: "bot_channel_webhook",
      after: {
        channel: message.channel,
        contactRef: message.contactRef,
        eventType: message.eventType,
        externalMessageId: message.externalMessageId,
      },
    });
  }

  const botRun =
    webhookSession && message.text && !duplicateWebhook
      ? await runBotChat({
          language: detectWebhookLanguage(message.text),
          payload: {
            ...(body as Record<string, unknown>),
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
    webhookSession && botRun && message.text && channelReplyDecision?.allowed && channelReplyDecision.mode !== "block"
      ? await evaluateOutboundConsent({
          channel: getConsentChannel(message.channel),
          metadata: {
            accountRef: message.accountRef,
            channel: message.channel,
            conversationId: botRun.conversationId,
            source: "bot_channel_webhook",
            webhookEventId,
          },
          phone: message.phone ?? message.contactRef,
          purpose: "botOutreach",
          session: webhookSession,
        })
      : null;
  const outboundDelivery =
    webhookSession && botRun && message.text && channelReplyDecision?.allowed && channelReplyDecision.mode !== "block" && outboundConsent?.allowed
      ? await sendBotChannelReply({
          accountRef: message.accountRef,
          channel: message.channel,
          credentials: channelAccount?.credentials ?? null,
          idempotencyKey: `bot-channel-reply:${webhookEventId ?? message.externalMessageId}`,
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

  if (webhookSession && botRun) {
    await writeAuditLog({
      session: webhookSession,
      action: "bot.channel_reply.decision",
      entityId: botRun.conversationId,
      entityType: "bot_conversation",
      after: {
        channelReplyDecision,
        outboundConsent,
        outboundDelivery,
        webhookEventId,
      },
    });
  }

  return NextResponse.json({
    accepted: true,
    botReply: botRun?.message ?? null,
    conversationId: botRun?.conversationId ?? null,
    duplicateWebhook,
    message,
    nextAction: duplicateWebhook ? "ignore_duplicate_message" : message.text ? "route_to_bot_chat" : "ignore_empty_message",
    outboundDelivery,
    outboundConsent,
    persisted: Boolean(webhookEventId || botRun?.conversationId),
    route: "/api/bots/chat",
    runSummary: botRun?.runSummary ?? null,
    webhookEventId,
  });
}
