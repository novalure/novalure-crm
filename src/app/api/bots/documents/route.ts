import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { documentApprovedFromPayload, evaluateBotAction, getBotRuntimeControls } from "@/lib/bots/policy";
import { sendBotDocument } from "@/lib/bots/provider-actions";
import { evaluateOutboundConsent, type ConsentPolicyChannel } from "@/lib/db/consent-policy";
import {
  insertBotDocumentSend,
  insertNewsletterSend,
  updateBotDocumentSendDelivery,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getPublicMediaUrl, listWorkspaceMedia } from "@/lib/media-store";

export const maxDuration = 30;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toPublicUrl(value: string | null | undefined, requestUrl: string) {
  if (!value) return null;

  try {
    return new URL(value, requestUrl).toString();
  } catch {
    return null;
  }
}

function getConsentChannel(channel: string, recipientEmail?: string | null): ConsentPolicyChannel {
  const normalized = channel.toLowerCase();
  if (normalized.includes("whatsapp")) return "WhatsApp";
  if (normalized.includes("instagram")) return "Instagram";
  return recipientEmail ? "E-Mail" : "WhatsApp";
}

async function safeListWorkspaceMedia(workspaceId: string) {
  try {
    return await listWorkspaceMedia(workspaceId);
  } catch {
    return {
      assets: [],
      quota: {
        limitBytes: 0,
        maxFileBytes: 0,
        remainingBytes: 0,
        usedBytes: 0,
      },
    };
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const media = await safeListWorkspaceMedia(auth.session.workspaceId);
  return NextResponse.json({
    assets: media.assets,
    documentTypes: ["expose", "offer", "pdf", "checklist"],
    quota: media.quota,
  });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const media = await safeListWorkspaceMedia(auth.session.workspaceId);
  const mediaAssetId = typeof input.mediaAssetId === "string" ? input.mediaAssetId : "";
  const asset = media.assets.find((item) => item.id === mediaAssetId) ?? null;

  if (!asset && !input.documentName) {
    return NextResponse.json({ error: "Missing document or media asset" }, { status: 400 });
  }

  const controls = getBotRuntimeControls(input);
  const channel = getString(input.channel) ?? "Webchat";
  const documentName = asset?.name ?? String(input.documentName);
  const documentUrl = toPublicUrl(asset ? getPublicMediaUrl(asset, request.url) : getString(input.documentUrl), request.url);
  const recipientEmail = getString(input.recipientEmail) ?? getString(input.email);
  const recipientName = getString(input.recipientName) ?? getString(input.contactName) ?? getString(input.name);
  const recipientPhone = getString(input.recipientPhone) ?? getString(input.phone);
  const decision = evaluateBotAction({
    action: "document_send",
    controls,
    document: {
      approved: documentApprovedFromPayload(input),
      publicUrl: documentUrl,
      recipient: recipientEmail ?? recipientPhone,
    },
    hasApprovedKnowledge: true,
    risk: "high",
  });
  const initialStatus = decision.mode === "test" ? "test" : decision.allowed ? "queued" : "blocked";
  const documentSendId = await insertBotDocumentSend({
    session: auth.session,
    botId: getString(input.botId),
    channel,
    contactId: getString(input.contactId),
    conversationId: getString(input.conversationId),
    documentName,
    mediaAssetId: asset?.id ?? null,
    metadata: {
      asset,
      customerData: {
        email: recipientEmail,
        name: recipientName,
        phone: recipientPhone,
      },
      decision,
      documentUrl,
      reason: input.reason ?? null,
      source: "bot_documents_api",
    },
    status: initialStatus,
  });

  await writeAuditLog({
    session: auth.session,
    action: "bot.document_send.policy_decision",
    entityId: documentSendId,
    entityType: "bot_document_send",
    after: { assetId: asset?.id ?? null, channel, decision, documentSendId },
  });

  if (!decision.allowed || decision.mode === "test") {
    return NextResponse.json({
      asset,
      decision,
      documentSendId,
      status: initialStatus,
    }, { status: decision.mode === "block" ? 409 : 202 });
  }

  const consentDecision = await evaluateOutboundConsent({
    channel: getConsentChannel(channel, recipientEmail),
    contactId: getString(input.contactId),
    email: recipientEmail,
    metadata: {
      botDocumentSendId: documentSendId,
      botId: getString(input.botId),
      channel,
      documentName,
      source: "bot_documents_api",
    },
    phone: recipientPhone,
    purpose: "botOutreach",
    session: auth.session,
  });

  if (!consentDecision.allowed) {
    await updateBotDocumentSendDelivery({
      session: auth.session,
      documentSendId,
      metadata: {
        consentDecision,
        lastDeliveryAttemptAt: new Date().toISOString(),
      },
      status: "blocked",
    });

    await writeAuditLog({
      session: auth.session,
      action: "bot.document_send.consent_blocked",
      entityId: documentSendId,
      entityType: "bot_document_send",
      after: { consentDecision, status: "blocked" },
    });

    return NextResponse.json({
      asset,
      consentDecision,
      decision,
      documentSendId,
      status: "blocked",
    }, { status: 409 });
  }

  const delivery = await sendBotDocument({
    channel,
    documentName,
    documentUrl,
    idempotencyKey: `bot-document-send:${documentSendId ?? crypto.randomUUID()}`,
    mediaMimeType: asset?.mimeType ?? null,
    recipientEmail,
    recipientName,
    recipientPhone,
  });
  const sentAt = delivery.status === "sent" ? new Date().toISOString() : null;

  await updateBotDocumentSendDelivery({
    session: auth.session,
    documentSendId,
    metadata: {
      consentDecision,
      delivery,
      deliveredAt: sentAt,
      lastDeliveryAttemptAt: new Date().toISOString(),
    },
    sentAt,
    status: delivery.status,
  });

  if (delivery.deliveryMode === "email" && delivery.recipient) {
    await insertNewsletterSend({
      session: auth.session,
      campaignId: null,
      contactId: getString(input.contactId),
      error: delivery.error ?? null,
      metadata: {
        botDocumentSendId: documentSendId,
        channel,
        consentDecision,
        deliveryMode: delivery.deliveryMode,
        source: "bot_documents_api",
      },
      provider: delivery.provider,
      providerMessageId: delivery.messageId ?? null,
      sentAt,
      status: delivery.status,
      subject: `Ihr angefragtes Dokument: ${documentName}`,
      toEmail: delivery.recipient,
    });
  }

  await writeAuditLog({
    session: auth.session,
    action: "bot.document_send.provider_delivery",
    entityId: documentSendId,
    entityType: "bot_document_send",
    after: { delivery, status: delivery.status },
  });

  return NextResponse.json({
    asset,
    decision,
    delivery,
    documentSendId,
    status: delivery.status,
  });
}
