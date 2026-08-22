import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getRolePermissions } from "@/lib/auth/permissions";
import type { AppSession } from "@/lib/auth/session";
import { runBotChat } from "@/lib/bots/chat-runtime";
import { getDurableBotWebhookEventKey, hashBotWebhookValue } from "@/lib/bots/webhook-event-key";
import { normalizeIncomingBotMessages, type NormalizedBotMessage } from "@/lib/bots/omnichannel";
import { readBoolean, type BotPolicyDecision } from "@/lib/bots/policy";
import { sendBotChannelReply, type BotChannelReplyDeliveryResult } from "@/lib/bots/provider-actions";
import {
  botWebhookMaxEventsPerBatch,
  botWebhookMaxProcessingAttempts,
  getBotWebhookMappingHttpStatus,
  getBotWebhookReplyAction,
  getBotWebhookReplySettlement,
  isBotWebhookReplyState,
  type BotWebhookReplyState,
} from "@/lib/bots/webhook-processing";
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
  beginBotChannelWebhookReplyAttempt,
  completeBotChannelWebhook,
  failBotChannelWebhook,
  findBotChannelAccountForWebhook,
  findBotChannelWebhookRunRecovery,
  ignoreBotChannelWebhook,
  insertBotChannelWebhook,
  persistBotChannelWebhookProcessingResult,
  quarantineBotChannelWebhookEnvelope,
  settleBotChannelWebhookReply,
  settleBotChannelWebhookReplyWithoutAttempt,
  quarantineBotChannelWebhookPayloadConflict,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import type { LanguageCode } from "@/lib/i18n";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { getProductRoleCapabilities } from "@/lib/product-model";

export const maxDuration = 30;

type ChannelAccountResolution = Awaited<ReturnType<typeof findBotChannelAccountForWebhook>>;
type MappedChannelAccount = Extract<ChannelAccountResolution, { status: "matched" }>["account"];
type SafeProvider = "custom" | "meta" | "unknown";
type SafeMappingStatus = ChannelAccountResolution["status"] | "not_attempted" | "unsupported";
type WebhookRunSnapshot = {
  channelReplyDecision: BotPolicyDecision | null;
  conversationId: string;
  messageContent: string;
  testMode: boolean;
};

type ClaimedWebhook = {
  id: string;
  leaseToken: string;
  workspaceId: string;
};

type WebhookEventOutcome = {
  mapping: SafeMappingStatus;
  state: string;
  terminal: boolean;
};

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

function readChannelReplyDecision(value: unknown): BotPolicyDecision | null {
  if (!isRecord(value)) return null;
  if (
    value.action !== "channel_reply" ||
    typeof value.allowed !== "boolean" ||
    typeof value.auditOnly !== "boolean" ||
    !["allow", "block", "test"].includes(String(value.mode)) ||
    typeof value.reason !== "string" ||
    typeof value.requiresHumanApproval !== "boolean" ||
    !["low", "medium", "high"].includes(String(value.risk))
  ) return null;

  return value as BotPolicyDecision;
}

function readWebhookRunSnapshot(value: unknown): WebhookRunSnapshot | null {
  if (!isRecord(value)) return null;
  const decision = value.channelReplyDecision === null
    ? null
    : readChannelReplyDecision(value.channelReplyDecision);
  if (
    typeof value.conversationId !== "string" ||
    typeof value.messageContent !== "string" ||
    typeof value.testMode !== "boolean" ||
    (value.channelReplyDecision !== null && !decision)
  ) return null;

  return {
    channelReplyDecision: decision,
    conversationId: value.conversationId,
    messageContent: value.messageContent,
    testMode: value.testMode,
  };
}

function recoverWebhookRunSnapshot(input: {
  conversationId: string;
  messageContent: string;
  messageMetadata: unknown;
}): WebhookRunSnapshot | null {
  const metadata = isRecord(input.messageMetadata) ? input.messageMetadata : {};
  const autonomy = isRecord(metadata.autonomy) ? metadata.autonomy : {};
  const controls = isRecord(autonomy.controls) ? autonomy.controls : {};
  const decisions = Array.isArray(autonomy.decisions) ? autonomy.decisions : [];
  const channelReplyDecision = decisions
    .map(readChannelReplyDecision)
    .find((decision): decision is BotPolicyDecision => Boolean(decision)) ?? null;

  if (!channelReplyDecision || typeof controls.testMode !== "boolean") return null;

  return {
    channelReplyDecision,
    conversationId: input.conversationId,
    messageContent: input.messageContent,
    testMode: controls.testMode,
  };
}

function toDurableDeliveryResult(delivery: BotChannelReplyDeliveryResult) {
  return {
    deliveryMode: delivery.deliveryMode,
    errorCode: delivery.error ? "provider_delivery_failed" : null,
    messageId: delivery.messageId ?? null,
    provider: delivery.provider,
    status: delivery.status,
  };
}

function toSafeReplyAudit(replyState: BotWebhookReplyState, replyResult: unknown) {
  const result = isRecord(replyResult) ? replyResult : {};
  return {
    deliveryMode: typeof result.deliveryMode === "string" ? result.deliveryMode : null,
    provider: typeof result.provider === "string" ? result.provider : null,
    state: replyState,
    status: typeof result.status === "string" ? result.status : null,
  };
}

function createWebhookSession(channelAccount: MappedChannelAccount): AppSession {
  return {
    authenticated: true,
    email: "bot-webhook@novalure.local",
    name: "Novalure Bot Webhook",
    permissions: getRolePermissions(channelAccount.actorRole),
    productPermissions: getProductRoleCapabilities(channelAccount.actorProductRole),
    productRole: channelAccount.actorProductRole,
    role: channelAccount.actorRole,
    source: "database",
    userId: channelAccount.actorUserId,
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

function toPersistedWebhookEvent(message: NormalizedBotMessage) {
  return {
    accountRef: message.accountRef ?? null,
    channel: message.channel,
    contactRef: message.contactRef,
    customerName: message.customerName ?? null,
    eventType: message.eventType,
    externalMessageId: message.externalMessageId,
    phone: message.phone ?? null,
    receivedAt: message.receivedAt,
    text: message.text,
  };
}

function getWebhookEventPayloadSha256(message: NormalizedBotMessage) {
  // receivedAt is intentionally excluded. Custom payloads without a provider
  // timestamp receive a local observation time that changes on a legitimate
  // retry; all provider identity and content fields remain conflict-protected.
  return createHash("sha256").update(JSON.stringify({
    accountRef: message.accountRef ?? null,
    channel: message.channel,
    contactRef: message.contactRef,
    customerName: message.customerName ?? null,
    eventType: message.eventType,
    externalMessageId: message.externalMessageId,
    phone: message.phone ?? null,
    text: message.text,
  })).digest("hex");
}

function prepareWebhookEvent(message: NormalizedBotMessage): {
  message: NormalizedBotMessage;
  quarantineReason: "invalid_event_field_bounds" | null;
} {
  let invalidFieldBounds = false;
  const bound = (value: string | null | undefined, maxLength: number) => {
    if (!value || value.length <= maxLength) return value ?? null;
    invalidFieldBounds = true;
    return `oversized_${hashBotWebhookValue(value)}`;
  };
  const accountRef = bound(message.accountRef, 256);
  const channel = bound(message.channel, 80) ?? "invalid";
  const contactRef = bound(message.contactRef, 512) ?? "anonymous";
  const customerName = bound(message.customerName, 256);
  const eventType = bound(message.eventType, 100) ?? "invalid_event";
  const phone = bound(message.phone, 80);
  const text = bound(message.text, 8_000) ?? "";

  return {
    message: {
      ...message,
      accountRef,
      channel,
      contactRef,
      customerName,
      eventType,
      // Every provider/custom identifier becomes one fixed-width opaque key.
      // This is both the durable identity and a B-tree tuple-size defense.
      externalMessageId: getDurableBotWebhookEventKey(message.externalMessageId),
      phone,
      text,
    },
    quarantineReason: invalidFieldBounds ? "invalid_event_field_bounds" : null,
  };
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

async function processNormalizedWebhookEvent(input: {
  correlationId: string;
  message: NormalizedBotMessage;
  provider: SafeProvider;
  quarantineReason?: string | null;
  rawBodySha256: string;
  requestUrl: string;
}): Promise<WebhookEventOutcome> {
  let mappingStatus: SafeMappingStatus = "not_attempted";
  let claimedWebhook: ClaimedWebhook | null = null;

  try {
    const channelAccountResolution = await findBotChannelAccountForWebhook({
      accountRef: input.message.accountRef,
      channel: input.message.channel,
    });
    mappingStatus = channelAccountResolution.status;

    if (channelAccountResolution.status !== "matched") {
      const httpStatus = getBotWebhookMappingHttpStatus(channelAccountResolution.status);
      const terminal = httpStatus === 200;
      const state = terminal ? "mapping_ignored" : "mapping_retryable";
      logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
      return { mapping: mappingStatus, state, terminal };
    }

    const channelAccount = channelAccountResolution.account;
    const webhookSession = createWebhookSession(channelAccount);
    const message = {
      ...input.message,
      accountRef: channelAccount.externalAccountId,
      channel: channelAccount.channel,
    };
    const webhookRecord = await insertBotChannelWebhook({
      actorUserId: webhookSession.userId,
      applyRateBudget: Boolean(message.text) && !input.quarantineReason,
      workspaceId: webhookSession.workspaceId,
      channelAccountId: channelAccount.id,
      contactRef: message.contactRef,
      eventType: message.eventType,
      externalMessageId: message.externalMessageId,
      normalizedMessage: message,
      // The signature was verified against the untouched body before fan-out.
      // Each row stores that body digest for evidence, while the claim conflict
      // hash below covers only this event so batch regrouping remains replayable.
      payload: {
        event: toPersistedWebhookEvent(message),
        signedRawBodySha256: input.rawBodySha256,
      },
      payloadSha256: getWebhookEventPayloadSha256(message),
    });

    if (!webhookRecord) throw new Error("webhook_event_not_persisted");

    if (webhookRecord.outcome === "payload_conflict") {
      const state = "event_payload_conflict";
      const quarantined = await quarantineBotChannelWebhookPayloadConflict({
        id: webhookRecord.id,
        workspaceId: webhookSession.workspaceId,
      });
      if (!quarantined) throw new Error("webhook_payload_conflict_not_quarantined");
      await writeAuditLog({
        session: webhookSession,
        action: "bot.webhook.payload_conflict",
        entityId: webhookRecord.id,
        entityType: "bot_channel_webhook",
        after: {
          quarantineReason: "payload_conflict",
          webhookEventId: webhookRecord.id,
        },
        webhookEventId: webhookRecord.id,
      });
      logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
      return { mapping: mappingStatus, state, terminal: true };
    }

    if (webhookRecord.outcome === "completed" || webhookRecord.outcome === "ignored") {
      const state = webhookRecord.outcome === "ignored"
        && "quarantineReason" in webhookRecord
        && typeof webhookRecord.quarantineReason === "string"
          ? webhookRecord.quarantineReason
          : `duplicate_${webhookRecord.outcome}`;
      logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
      return { mapping: mappingStatus, state, terminal: true };
    }

    if (webhookRecord.outcome === "in_flight") {
      const state = "duplicate_in_flight";
      logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
      // Do not acknowledge a concurrent delivery as accepted: this route has
      // no background scanner that could reclaim a later failed/expired lease.
      return { mapping: mappingStatus, state, terminal: false };
    }

    if (webhookRecord.outcome !== "claimed" || !webhookRecord.leaseToken) {
      throw new Error("webhook_claim_invalid");
    }
    const activeWebhook: ClaimedWebhook = {
      id: webhookRecord.id,
      leaseToken: webhookRecord.leaseToken,
      workspaceId: webhookSession.workspaceId,
    };
    claimedWebhook = activeWebhook;
    const webhookEventId = webhookRecord.id;

    const settleIgnored = async (reason: string) => {
      const ignored = await ignoreBotChannelWebhook({
        ...activeWebhook,
        processingResult: { eventType: message.eventType, reason },
        reason,
      });
      if (!ignored) throw new Error("webhook_ignore_lease_lost");
      logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: reason });
      return { mapping: mappingStatus, state: reason, terminal: true } satisfies WebhookEventOutcome;
    };

    if (webhookRecord.processingAttempt > botWebhookMaxProcessingAttempts) {
      return settleIgnored("retry_budget_exhausted");
    }

    if (input.quarantineReason) return settleIgnored(input.quarantineReason);

    if (!message.text) {
      return settleIgnored("no_processable_text");
    }

    let runSnapshot = readWebhookRunSnapshot(webhookRecord.processingResult);
    if (!runSnapshot) {
      const recovery = await findBotChannelWebhookRunRecovery({
        id: webhookEventId,
        session: webhookSession,
      });
      runSnapshot = recovery ? recoverWebhookRunSnapshot(recovery) : null;
    }

    if (!runSnapshot) {
      const botRun = await runBotChat({
        language: detectWebhookLanguage(message.text),
        payload: {
          botId: channelAccount.botId,
          channel: message.channel,
          contactRef: message.contactRef,
          name: message.customerName,
          externalMessageId: message.externalMessageId,
          phone: message.phone,
          projectId: channelAccount.projectId,
          prompt: message.text,
          source: "channel_webhook",
          title: `${message.channel}: ${message.contactRef}`,
          webhookEventId,
        },
        requestUrl: input.requestUrl,
        session: webhookSession,
      });
      runSnapshot = {
        channelReplyDecision:
          botRun.autonomy.decisions.find((decision) => decision.action === "channel_reply") ?? null,
        conversationId: botRun.conversationId,
        messageContent: botRun.message.content,
        testMode: botRun.autonomy.controls.testMode,
      };
    }

    const processingResultPersisted = await persistBotChannelWebhookProcessingResult({
      ...activeWebhook,
      processingResult: runSnapshot,
    });
    if (!processingResultPersisted) throw new Error("webhook_processing_result_lease_lost");

    const channelReplyDecision = runSnapshot.channelReplyDecision;
    const shouldReply = Boolean(channelReplyDecision?.allowed && channelReplyDecision.mode !== "block");
    const outboundConsent = shouldReply
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
    let replyState = isBotWebhookReplyState(webhookRecord.replyState)
      ? webhookRecord.replyState
      : "not_requested";
    let replyResult = webhookRecord.replyResult;

    if (!shouldReply) {
      if (replyState === "not_requested") {
        const settled = await settleBotChannelWebhookReplyWithoutAttempt({
          ...activeWebhook,
          replyResult: { reason: "channel_reply_policy_blocked" },
          replyState: "not_applicable",
        });
        if (!settled) throw new Error("webhook_reply_policy_settlement_failed");
        replyState = "not_applicable";
        replyResult = { reason: "channel_reply_policy_blocked" };
      }
    } else if (outboundConsent && !outboundConsent.allowed) {
      if (replyState === "not_requested") {
        replyResult = {
          reason: `consent_${outboundConsent.reason}`,
          status: "blocked",
        };
        const settled = await settleBotChannelWebhookReplyWithoutAttempt({
          ...activeWebhook,
          replyResult,
          replyState: "blocked",
        });
        if (!settled) throw new Error("webhook_reply_consent_settlement_failed");
        replyState = "blocked";
      }
    } else if (outboundConsent?.allowed) {
      const replyAction = getBotWebhookReplyAction(replyState);
      if (replyAction === "attempt") {
        const attempt = await beginBotChannelWebhookReplyAttempt(activeWebhook);
        if (!attempt || attempt.replyState !== "attempting" || !attempt.replyAttemptToken) {
          throw new Error("webhook_reply_attempt_not_acquired");
        }

        const delivery = await sendBotChannelReply({
          accountRef: channelAccount.externalAccountId,
          channel: channelAccount.channel,
          credentials: channelAccount.credentials,
          // This key is diagnostic only for Meta. The durable attempt row is
          // the actual duplicate-send guard.
          idempotencyKey: `bot-channel-reply:${webhookEventId}`,
          message: runSnapshot.messageContent,
          recipientPhone: message.phone ?? message.contactRef,
          testMode: runSnapshot.testMode || channelReplyDecision?.mode === "test",
        });
        replyState = getBotWebhookReplySettlement(delivery.status);
        replyResult = toDurableDeliveryResult(delivery);
        const settled = await settleBotChannelWebhookReply({
          ...activeWebhook,
          replyAttemptToken: attempt.replyAttemptToken,
          replyResult,
          replyState,
        });
        if (!settled) throw new Error("webhook_reply_attempt_settlement_failed");
      }
    }

    if (replyState === "attempting") throw new Error("webhook_reply_attempt_unsettled");

    await writeAuditLog({
      session: webhookSession,
      action: "bot.channel_reply.decision",
      entityId: runSnapshot.conversationId,
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
        outboundDelivery: toSafeReplyAudit(replyState, replyResult),
        webhookEventId,
      },
      webhookEventId,
    });

    const completed = await completeBotChannelWebhook(activeWebhook);
    if (!completed) throw new Error("webhook_completion_lease_lost");

    const state = "processed";
    logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
    return { mapping: mappingStatus, state, terminal: true };
  } catch {
    if (claimedWebhook) {
      try {
        await failBotChannelWebhook({
          ...claimedWebhook,
          reason: "processing_failed",
        });
      } catch {
        // The aggregate 503 remains the provider retry signal. Failure to write
        // the failure state must not expose request or credential details.
      }
    }
    const state = "processing_error";
    logWebhookStatus({ correlationId: input.correlationId, mapping: mappingStatus, provider: input.provider, status: state });
    return { mapping: mappingStatus, state, terminal: false };
  }
}

export async function POST(request: Request) {
  const correlationId = randomUUID();
  let provider: SafeProvider = "unknown";

  try {
    if (!evaluateLaunchScope("botChannelInboundProcessing").allowed) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "launch_scope_blocked" });
      return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "webhook_unavailable" });
    }

    if (webhookProcessingDisabled()) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "processing_disabled" });
      return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "webhook_unavailable" });
    }

    if (!isJsonWebhookContentType(request.headers.get("content-type"))) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "content_type_rejected" });
      return jsonWebhookResponse(correlationId, 415, { accepted: false, error: "unsupported_content_type" });
    }

    if (!hasSupportedWebhookContentEncoding(request.headers.get("content-encoding"))) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "content_encoding_rejected" });
      return jsonWebhookResponse(correlationId, 415, { accepted: false, error: "unsupported_content_encoding" });
    }

    const rawBodyResult = await readLimitedWebhookBody(request);
    if (!rawBodyResult.ok) {
      const status = rawBodyResult.reason === "payload_too_large" ? 413 : 400;
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: rawBodyResult.reason });
      return jsonWebhookResponse(correlationId, status, { accepted: false, error: rawBodyResult.reason });
    }

    const body = parseJson(rawBodyResult.body);
    if (!isRecord(body)) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "invalid_json" });
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
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "authentication_rejected" });
      return jsonWebhookResponse(correlationId, 401, { accepted: false, error: "unauthorized" });
    }

    const normalizedMessages = normalizeIncomingBotMessages(body);
    if (!normalizedMessages.length) {
      if (metaPayload) {
        logWebhookStatus({ correlationId, mapping: "unsupported", provider, status: "unsupported_event_ignored" });
        return jsonWebhookResponse(correlationId, 200);
      }
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "event_rejected" });
      return jsonWebhookResponse(correlationId, 400, { accepted: false, error: "invalid_event" });
    }

    const rawBodySha256 = createHash("sha256").update(rawBodyResult.body).digest("hex");
    const preparedEvents = normalizedMessages.map(prepareWebhookEvent);
    if (preparedEvents.length > botWebhookMaxEventsPerBatch) {
      // The complete signed envelope is durably referenced by its raw-body
      // digest. No individual event is silently treated as representative of
      // the rest, and persistence failure stays retryable.
      const envelope = await quarantineBotChannelWebhookEnvelope({
        eventCount: preparedEvents.length,
        payloadSha256: rawBodySha256,
        provider,
        reason: "batch_event_limit_exceeded",
      });
      if (!envelope) throw new Error("webhook_batch_envelope_not_quarantined");
      logWebhookStatus({
        correlationId,
        mapping: "unsupported",
        provider,
        status: "batch_quarantined",
      });
      return jsonWebhookResponse(correlationId, 200);
    }

    const outcomes: WebhookEventOutcome[] = [];
    // Sequential processing makes duplicate ids inside one provider batch an
    // immediate terminal replay and keeps claim/effect ordering deterministic.
    // A failure does not stop later events: the provider retries the batch,
    // completed rows ack-replay, and only unfinished rows are reclaimed.
    for (const prepared of preparedEvents) {
      outcomes.push(await processNormalizedWebhookEvent({
        correlationId,
        message: prepared.message,
        provider,
        quarantineReason: prepared.quarantineReason,
        rawBodySha256,
        requestUrl: request.url,
      }));
    }

    if (outcomes.some((outcome) => !outcome.terminal)) {
      logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "batch_incomplete" });
      return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "webhook_batch_incomplete" });
    }

    logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "batch_completed" });
    return jsonWebhookResponse(correlationId, 200);
  } catch {
    logWebhookStatus({ correlationId, mapping: "not_attempted", provider, status: "processing_error" });
    return jsonWebhookResponse(correlationId, 503, { accepted: false, error: "processing_failed" });
  }
}
