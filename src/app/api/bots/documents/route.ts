import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { documentApprovedFromPayload, evaluateBotAction, getBotRuntimeControls } from "@/lib/bots/policy";
import { sendBotDocument } from "@/lib/bots/provider-actions";
import { evaluateOutboundConsent, type ConsentPolicyChannel } from "@/lib/db/consent-policy";
import { queryOne } from "@/lib/db/client";
import {
  canPersist,
  insertBotDocumentSend,
  insertNewsletterSend,
  isUuid,
  updateBotDocumentSendDelivery,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import {
  botDocumentAttemptShareTtlSeconds,
  botDocumentMediaShareTtlSeconds,
  extendWorkspaceMediaShare,
  getPublicMediaUrl,
  listWorkspaceMedia,
  publishWorkspaceMedia,
  revokeWorkspaceMediaShare,
  serializeMediaAsset,
} from "@/lib/media-store";
import { evaluateLaunchScope } from "@/lib/launch-scope";

const privateJsonHeaders = { "cache-control": "private, no-store" };

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

async function claimDocumentDeliveryAttempt(input: {
  documentSendId: string;
  deliveryAttemptId: string;
  workspaceId: string;
}) {
  return Boolean(await queryOne<{ id: string }>(
    `
      update bot_document_sends
      set status = 'sending',
          metadata = metadata || $3::jsonb
      where id = $1
        and workspace_id = $2
        and status not in ('sent', 'sending')
        and coalesce(metadata->>'deliveryAttemptState', '') <> 'in_flight'
      returning id
    `,
    [
      input.documentSendId,
      input.workspaceId,
      JSON.stringify({
        deliveryAttemptId: input.deliveryAttemptId,
        deliveryAttemptStartedAt: new Date().toISOString(),
        deliveryAttemptState: "in_flight",
      }),
    ],
  ));
}

async function updateDocumentDeliveryAttempt(input: {
  documentSendId: string;
  deliveryAttemptId: string;
  metadata: Record<string, unknown>;
  sentAt?: string | null;
  status: string;
  workspaceId: string;
}) {
  return Boolean(await queryOne<{ id: string }>(
    `
      update bot_document_sends
      set status = $4,
          sent_at = coalesce($5::timestamptz, sent_at),
          metadata = metadata || $6::jsonb
      where id = $1
        and workspace_id = $2
        and status = 'sending'
        and metadata->>'deliveryAttemptId' = $3
      returning id
    `,
    [
      input.documentSendId,
      input.workspaceId,
      input.deliveryAttemptId,
      input.status,
      input.sentAt ?? null,
      JSON.stringify(input.metadata),
    ],
  ));
}

function toPersistedDocumentDelivery(delivery: Awaited<ReturnType<typeof sendBotDocument>>) {
  return {
    deliveryMode: delivery.deliveryMode,
    errorCode: delivery.error ? "provider_delivery_failed" : null,
    messageId: delivery.messageId ?? null,
    provider: delivery.provider,
    recipient: delivery.recipient,
    status: delivery.status,
  };
}

async function revokeDocumentAttemptShare(input: {
  assetId: string;
  publicShareId: string;
  workspaceId: string;
}) {
  try {
    return await revokeWorkspaceMediaShare(input.assetId, input.workspaceId, input.publicShareId)
      ? "revoked"
      : "failed";
  } catch {
    return "failed";
  }
}

async function extendSentDocumentShare(input: {
  assetId: string;
  publicShareId: string;
  workspaceId: string;
}) {
  try {
    const share = await extendWorkspaceMediaShare(
      input.assetId,
      input.workspaceId,
      input.publicShareId,
      botDocumentMediaShareTtlSeconds,
    );
    return share
      ? {
          expiresAt: share.expiresAt instanceof Date ? share.expiresAt.toISOString() : String(share.expiresAt),
          state: "extended" as const,
        }
      : { expiresAt: null, state: "failed" as const };
  } catch {
    return { expiresAt: null, state: "failed" as const };
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const media = await safeListWorkspaceMedia(auth.session.workspaceId);
  return NextResponse.json(
    {
      assets: media.assets.map(serializeMediaAsset),
      documentTypes: ["expose", "offer", "pdf", "checklist"],
      quota: media.quota,
    },
    { headers: privateJsonHeaders },
  );
}

export async function POST(request: Request) {
  if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) {
    return NextResponse.json(
      { error: "bot_provider_delivery_launch_off" },
      { headers: privateJsonHeaders, status: 503 },
    );
  }

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
  const recipientEmail = getString(input.recipientEmail) ?? getString(input.email);
  const recipientName = getString(input.recipientName) ?? getString(input.contactName) ?? getString(input.name);
  const recipientPhone = getString(input.recipientPhone) ?? getString(input.phone);
  const approved = documentApprovedFromPayload(input);
  let documentUrl = asset
    ? null
    : toPublicUrl(getString(input.documentUrl), request.url);
  const decision = evaluateBotAction({
    action: "document_send",
    controls,
    document: {
      approved,
      publicUrl: asset ? toPublicUrl("/api/media/public/pending", request.url) : documentUrl,
      recipient: recipientEmail ?? recipientPhone,
    },
    hasApprovedKnowledge: true,
    risk: "high",
  });

  const clientAsset = asset ? serializeMediaAsset(asset) : null;
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
      assetId: asset?.id ?? null,
      customerData: {
        email: recipientEmail,
        name: recipientName,
        phone: recipientPhone,
      },
      decision,
      publicShareCreated: false,
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
      asset: clientAsset,
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
      asset: clientAsset,
      consentDecision,
      decision,
      documentSendId,
      status: "blocked",
    }, { status: 409 });
  }

  if (!canPersist() || !isUuid(documentSendId)) {
    return NextResponse.json({ error: "Document delivery requires durable storage" }, { status: 503 });
  }

  const deliveryAttemptId = crypto.randomUUID();
  const claimed = await claimDocumentDeliveryAttempt({
    deliveryAttemptId,
    documentSendId,
    workspaceId: auth.session.workspaceId,
  });
  if (!claimed) {
    return NextResponse.json({ error: "Document delivery was already claimed" }, { status: 409 });
  }

  let publishedAsset: Awaited<ReturnType<typeof publishWorkspaceMedia>> = null;
  if (asset) {
    try {
      publishedAsset = await publishWorkspaceMedia(asset.id, auth.session.workspaceId, {
        expiresInSeconds: botDocumentAttemptShareTtlSeconds,
      });
    } catch {
      await updateDocumentDeliveryAttempt({
        deliveryAttemptId,
        documentSendId,
        metadata: {
          deliveryAttemptFinishedAt: new Date().toISOString(),
          deliveryAttemptState: "failed",
          deliveryErrorCode: "share_creation_failed",
        },
        status: "failed",
        workspaceId: auth.session.workspaceId,
      });
      return NextResponse.json({ error: "Document share could not be created" }, { status: 503 });
    }

    documentUrl = publishedAsset
      ? toPublicUrl(getPublicMediaUrl(publishedAsset, request.url), request.url)
      : null;
    if (!(publishedAsset?.publicShareId && publishedAsset.publicShareExpiresAt && documentUrl)) {
      const publicShareRevocationState = publishedAsset?.publicShareId
        ? await revokeDocumentAttemptShare({
            assetId: asset.id,
            publicShareId: publishedAsset.publicShareId,
            workspaceId: auth.session.workspaceId,
          })
        : "not_required";
      await updateDocumentDeliveryAttempt({
        deliveryAttemptId,
        documentSendId,
        metadata: {
          deliveryAttemptFinishedAt: new Date().toISOString(),
          deliveryAttemptState: "failed",
          deliveryErrorCode: "share_publication_incomplete",
          publicShareRevocationState,
        },
        status: "failed",
        workspaceId: auth.session.workspaceId,
      });
      return NextResponse.json({ error: "Document share could not be created" }, { status: 503 });
    }

    const publicationTracked = await updateDocumentDeliveryAttempt({
      deliveryAttemptId,
      documentSendId,
      metadata: {
        deliveryAttemptState: "in_flight",
        publicShareExpiresAt: publishedAsset.publicShareExpiresAt,
        publicShareId: publishedAsset.publicShareId,
      },
      status: "sending",
      workspaceId: auth.session.workspaceId,
    });
    if (!publicationTracked) {
      await revokeDocumentAttemptShare({
        assetId: asset.id,
        publicShareId: publishedAsset.publicShareId,
        workspaceId: auth.session.workspaceId,
      });
      return NextResponse.json({ error: "Document delivery claim was lost" }, { status: 409 });
    }
  }

  let delivery: Awaited<ReturnType<typeof sendBotDocument>>;
  try {
    delivery = await sendBotDocument({
      channel,
      documentName,
      documentUrl,
      idempotencyKey: `bot-document-send:${documentSendId}`,
      mediaMimeType: asset?.mimeType ?? null,
      recipientEmail,
      recipientName,
      recipientPhone,
    });
  } catch {
    const publicShareRevocationState = asset && publishedAsset?.publicShareId
      ? await revokeDocumentAttemptShare({
          assetId: asset.id,
          publicShareId: publishedAsset.publicShareId,
          workspaceId: auth.session.workspaceId,
        })
      : "not_required";
    await updateDocumentDeliveryAttempt({
      deliveryAttemptId,
      documentSendId,
      metadata: {
        deliveryAttemptFinishedAt: new Date().toISOString(),
        deliveryAttemptState: "failed",
        deliveryErrorCode: "provider_exception",
        publicShareRevokedAt: asset ? new Date().toISOString() : null,
        publicShareRevocationState,
      },
      status: "failed",
      workspaceId: auth.session.workspaceId,
    });
    return NextResponse.json({ error: "Document provider failed" }, { status: 502 });
  }
  const sentAt = delivery.status === "sent" ? new Date().toISOString() : null;

  const publicShareRevokedAt = asset && delivery.status !== "sent" ? new Date().toISOString() : null;
  const publicShareRevocationState = asset && publishedAsset?.publicShareId && publicShareRevokedAt
    ? await revokeDocumentAttemptShare({
        assetId: asset.id,
        publicShareId: publishedAsset.publicShareId,
        workspaceId: auth.session.workspaceId,
      })
    : "not_required";
  const publicShareExtension = asset && publishedAsset?.publicShareId && sentAt
    ? await extendSentDocumentShare({
        assetId: asset.id,
        publicShareId: publishedAsset.publicShareId,
        workspaceId: auth.session.workspaceId,
      })
    : { expiresAt: null, state: "not_required" as const };
  const persistedDelivery = toPersistedDocumentDelivery(delivery);

  const deliveryUpdated = await updateDocumentDeliveryAttempt({
    deliveryAttemptId,
    documentSendId,
    metadata: {
      consentDecision,
      delivery: persistedDelivery,
      deliveredAt: sentAt,
      deliveryAttemptFinishedAt: new Date().toISOString(),
      deliveryAttemptState: delivery.status === "sent" ? "sent" : "failed",
      lastDeliveryAttemptAt: new Date().toISOString(),
      publicShareExpiresAt: publicShareExtension.expiresAt ?? publishedAsset?.publicShareExpiresAt ?? null,
      publicShareExtensionState: publicShareExtension.state,
      publicShareId: publishedAsset?.publicShareId ?? null,
      publicShareRevokedAt,
      publicShareRevocationState,
    },
    sentAt,
    status: delivery.status,
    workspaceId: auth.session.workspaceId,
  });
  if (!deliveryUpdated) {
    return NextResponse.json({ error: "Document delivery result could not be persisted" }, { status: 503 });
  }

  if (delivery.deliveryMode === "email" && delivery.recipient) {
    await insertNewsletterSend({
      session: auth.session,
      campaignId: null,
      contactId: getString(input.contactId),
      deliveryPurpose: "bot_document",
      error: delivery.error ? "provider_delivery_failed" : null,
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
    after: { delivery: persistedDelivery, status: delivery.status },
  });

  return NextResponse.json({
    asset: clientAsset,
    decision,
    delivery,
    documentSendId,
    status: delivery.status,
  });
}
