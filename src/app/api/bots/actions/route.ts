import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { evaluateBotAction, getBotRuntimeControls } from "@/lib/bots/policy";
import { sendBotDocument } from "@/lib/bots/provider-actions";
import { evaluateOutboundConsent, type ConsentPolicyChannel } from "@/lib/db/consent-policy";
import { canAccessContentMediaAsset } from "@/lib/db/content-library-repositories";
import { queryOne, queryRows } from "@/lib/db/client";
import { confirmMeetingBooking } from "@/lib/db/meeting-repositories";
import { canPersist, insertNewsletterSend, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import {
  botDocumentAttemptShareTtlSeconds,
  botDocumentMediaShareTtlSeconds,
  extendWorkspaceMediaShare,
  findWorkspaceMediaAsset,
  getPublicMediaUrl,
  publishWorkspaceMedia,
  revokeWorkspaceMediaShare,
} from "@/lib/media-store";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const maxDuration = 30;

type BotDocumentSendRow = {
  id: string;
  channel: string;
  contactId: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  createdAt: string;
  documentName: string;
  mediaAssetId: string | null;
  mediaAssetHasActivePublicShare: boolean | null;
  mediaAssetIsPublic: boolean | null;
  mediaAssetMimeType: string | null;
  mediaAssetName: string | null;
  mediaAssetUrl: string | null;
  metadata: unknown;
  sentAt: string | null;
  status: string;
};

type BotMeetingBookingRow = {
  id: string;
  contactEmail: string;
  contactName: string;
  createdAt: string;
  endsAt: string;
  slug: string;
  startsAt: string;
  status: string;
  title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getCustomerData(metadata: unknown) {
  const data = isRecord(metadata) && isRecord(metadata.customerData) ? metadata.customerData : {};

  return {
    email: getString(data.email),
    name: getString(data.name),
    phone: getString(data.phone),
  };
}

function toPublicUrl(value: string | null, requestUrl: string) {
  if (!value) return null;

  try {
    return new URL(value, requestUrl).toString();
  } catch {
    return null;
  }
}

function toClientDocumentSend(documentSend: BotDocumentSendRow): BotDocumentSendRow {
  return {
    ...documentSend,
    mediaAssetUrl: documentSend.mediaAssetId ? `/api/media/files/${documentSend.mediaAssetId}` : null,
    metadata: sanitizeDocumentSendMetadata(documentSend.metadata),
  };
}

function sanitizeDocumentSendMetadata(metadata: unknown) {
  if (!isRecord(metadata)) return {};

  const sanitized = { ...metadata };
  delete sanitized.asset;
  delete sanitized.attachedMediaAssetPublicUrl;
  delete sanitized.attachedMediaAssetUrl;
  delete sanitized.documentUrl;
  return sanitized;
}

function getConsentChannel(channel: string, recipientEmail?: string | null): ConsentPolicyChannel {
  const normalized = channel.toLowerCase();
  if (normalized.includes("whatsapp")) return "WhatsApp";
  if (normalized.includes("instagram")) return "Instagram";
  return recipientEmail ? "E-Mail" : "WhatsApp";
}

function getDocumentSendSelect(whereSql: string) {
  return `
    select
      bds.id,
      bds.channel,
      bds.contact_id as "contactId",
      coalesce(c.email, bds.metadata->'customerData'->>'email') as "contactEmail",
      coalesce(c.name, bds.metadata->'customerData'->>'name') as "contactName",
      coalesce(c.phone, bds.metadata->'customerData'->>'phone') as "contactPhone",
      bds.conversation_id as "conversationId",
      bc.title as "conversationTitle",
      bds.created_at as "createdAt",
      bds.document_name as "documentName",
      bds.media_asset_id as "mediaAssetId",
      exists (
        select 1
        from media_asset_shares mas
        where mas.asset_id = ma.id
          and mas.workspace_id = ma.workspace_id
          and mas.scope = 'public-download'
          and mas.revoked_at is null
          and mas.expires_at > now()
      ) as "mediaAssetHasActivePublicShare",
      ma.is_public as "mediaAssetIsPublic",
      ma.mime_type as "mediaAssetMimeType",
      ma.name as "mediaAssetName",
      case when ma.id is null then null else '/api/media/files/' || ma.id::text end as "mediaAssetUrl",
      bds.metadata,
      bds.sent_at as "sentAt",
      bds.status
    from bot_document_sends bds
    left join bot_conversations bc on bc.id = bds.conversation_id and bc.workspace_id = bds.workspace_id
    left join contacts c on c.id = bds.contact_id and c.workspace_id = bds.workspace_id
    left join media_assets ma on ma.id = bds.media_asset_id and ma.workspace_id = bds.workspace_id::text
    ${whereSql}
  `;
}

function getMeetingBookingSelect(whereSql: string) {
  return `
    select
      id,
      contact_email as "contactEmail",
      contact_name as "contactName",
      created_at as "createdAt",
      ends_at as "endsAt",
      slug,
      starts_at as "startsAt",
      status,
      title
    from meeting_bookings
    ${whereSql}
  `;
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function claimDocumentDeliveryAttempt(input: {
  documentSendId: string;
  deliveryAttemptId: string;
  workspaceId: string;
}) {
  const startedAt = new Date().toISOString();
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
        deliveryAttemptStartedAt: startedAt,
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
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  if (!canPersist() || !isUuid(auth.session.workspaceId)) {
    return NextResponse.json({
      documentSends: [],
      meetingBookings: [],
      metrics: { openDocuments: 0, openMeetings: 0 },
      source: "demo",
    });
  }

  const documentSends = (await queryRows<BotDocumentSendRow>(
    `${getDocumentSendSelect(`
      where bds.workspace_id = $1
    `)}
    order by "createdAt" desc
    limit 50`,
    [auth.session.workspaceId],
  )).map(toClientDocumentSend);

  const meetingBookings = await queryRows<BotMeetingBookingRow>(
    `${getMeetingBookingSelect(`
      where workspace_id = $1
        and source in ('bot_approval', 'bot_autonomy', 'bot')
    `)}
    order by "createdAt" desc
    limit 50`,
    [auth.session.workspaceId],
  );

  return NextResponse.json({
    documentSends,
    meetingBookings,
    metrics: {
      openDocuments: documentSends.filter((item) => item.status !== "sent").length,
      openMeetings: meetingBookings.filter((item) => item.status === "requested").length,
    },
    source: "database",
  });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!canPersist() || !isUuid(auth.session.workspaceId)) {
    return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 503 });
  }

  const input = body as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id : "";
  const type = typeof input.type === "string" ? input.type : "";
  const action = typeof input.action === "string" ? input.action : "";
  const controls = getBotRuntimeControls(input);

  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid action id" }, { status: 400 });
  }

  if (type === "document_send" && action === "attach_media_asset") {
    const mediaAssetId = typeof input.mediaAssetId === "string" ? input.mediaAssetId : "";

    if (!isUuid(mediaAssetId)) {
      return NextResponse.json({ error: "Invalid media asset id" }, { status: 400 });
    }

    if (!await canAccessContentMediaAsset({ assetId: mediaAssetId, reuse: true, session: auth.session })) {
      return NextResponse.json({ error: "Media asset not found" }, { status: 404 });
    }

    const mediaAsset = await findWorkspaceMediaAsset(mediaAssetId, auth.session.workspaceId);

    if (!mediaAsset) {
      return NextResponse.json({ error: "Media asset not found" }, { status: 404 });
    }

    const documentSend = await queryOne<{ id: string }>(
      `
        update bot_document_sends
        set media_asset_id = $3,
            document_name = $4,
            status = case when status = 'sent' then status else 'ready_to_send' end,
            metadata = metadata || $5::jsonb
        where id = $1
          and workspace_id = $2
        returning id
      `,
      [
        id,
        auth.session.workspaceId,
        mediaAsset.id,
        mediaAsset.name,
        JSON.stringify({
          attachedAt: new Date().toISOString(),
          attachedMediaAssetId: mediaAsset.id,
          attachedMediaAssetMimeType: mediaAsset.mimeType,
          publicShareCreated: false,
        }),
      ],
    );

    if (!documentSend) {
      return NextResponse.json({ error: "Document action not found" }, { status: 404 });
    }

    const updatedDocumentSend = await queryOne<BotDocumentSendRow>(
      `${getDocumentSendSelect(`
        where bds.id = $1
          and bds.workspace_id = $2
      `)}
      limit 1`,
      [id, auth.session.workspaceId],
    );

    await writeAuditLog({
      session: auth.session,
      action: "bot.document_send.attach_media_asset",
      entityId: id,
      entityType: "bot_document_send",
      after: {
        mediaAsset: {
          id: mediaAsset.id,
          mimeType: mediaAsset.mimeType,
          name: mediaAsset.name,
          url: `/api/media/files/${mediaAsset.id}`,
        },
        status: updatedDocumentSend?.status ?? "ready_to_send",
      },
    });

    return NextResponse.json({
      documentSend: updatedDocumentSend ? toClientDocumentSend(updatedDocumentSend) : null,
      status: updatedDocumentSend?.status ?? "ready_to_send",
    });
  }

  if (type === "document_send" && action === "mark_sent") {
    if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) {
      return NextResponse.json(
        { error: "bot_provider_delivery_launch_off" },
        { headers: { "Cache-Control": "private, no-store" }, status: 503 },
      );
    }

    const existingDocumentSend = await queryOne<BotDocumentSendRow>(
      `${getDocumentSendSelect(`
        where bds.id = $1
          and bds.workspace_id = $2
      `)}
      limit 1`,
      [id, auth.session.workspaceId],
    );

    if (!existingDocumentSend) {
      return NextResponse.json({ error: "Document action not found" }, { status: 404 });
    }

    if (["approval_required", "blocked"].includes(existingDocumentSend.status)) {
      return NextResponse.json({ error: "Document is not approved for sending" }, { status: 409 });
    }

    if (existingDocumentSend.status === "sent") {
      return NextResponse.json({
        documentSend: toClientDocumentSend(existingDocumentSend),
        replay: true,
        status: "sent",
      });
    }

    if (existingDocumentSend.status === "sending") {
      return NextResponse.json(
        { documentSend: toClientDocumentSend(existingDocumentSend), error: "Document delivery is already in flight" },
        { status: 409 },
      );
    }

    const clientDocumentSend = toClientDocumentSend(existingDocumentSend);
    const prospectivePublicUrl = existingDocumentSend.mediaAssetId
      ? toPublicUrl("/api/media/public/pending", request.url)
      : null;

    const customerData = getCustomerData(existingDocumentSend.metadata);
    const decision = evaluateBotAction({
      action: "document_send",
      controls,
      document: {
        approved: true,
        publicUrl: prospectivePublicUrl,
        recipient: existingDocumentSend.contactEmail ?? customerData.email ?? existingDocumentSend.contactPhone ?? customerData.phone,
      },
      risk: "high",
    });

    if (!decision.allowed || decision.mode === "test") {
      await writeAuditLog({
        session: auth.session,
        action: "bot.document_send.manual_policy_decision",
        entityId: existingDocumentSend.id,
        entityType: "bot_document_send",
        after: {
          decision,
          status: decision.mode === "test" ? "test" : "blocked",
        },
      });

      return NextResponse.json({
        decision,
        documentSend: clientDocumentSend,
        status: decision.mode === "test" ? "test" : "blocked",
      }, { status: decision.mode === "block" ? 409 : 202 });
    }

    const consentDecision = await evaluateOutboundConsent({
      channel: getConsentChannel(
        existingDocumentSend.channel,
        existingDocumentSend.contactEmail ?? customerData.email,
      ),
      contactId: existingDocumentSend.contactId,
      email: existingDocumentSend.contactEmail ?? customerData.email,
      metadata: {
        botDocumentSendId: existingDocumentSend.id,
        channel: existingDocumentSend.channel,
        documentName: existingDocumentSend.mediaAssetName ?? existingDocumentSend.documentName,
        source: "bot_action_outbox",
      },
      phone: existingDocumentSend.contactPhone ?? customerData.phone,
      purpose: "botOutreach",
      session: auth.session,
    });

    if (!consentDecision.allowed) {
      await queryOne<{ id: string }>(
        `
          update bot_document_sends
          set status = 'blocked',
              metadata = metadata || $3::jsonb
          where id = $1
            and workspace_id = $2
          returning id
        `,
        [
          existingDocumentSend.id,
          auth.session.workspaceId,
          JSON.stringify({
            consentDecision,
            lastDeliveryAttemptAt: new Date().toISOString(),
          }),
        ],
      );

      await writeAuditLog({
        session: auth.session,
        action: "bot.document_send.consent_blocked",
        entityId: existingDocumentSend.id,
        entityType: "bot_document_send",
        after: { consentDecision, status: "blocked" },
      });

      return NextResponse.json({
        consentDecision,
        documentSend: clientDocumentSend,
        status: "blocked",
      }, { status: 409 });
    }

    if (!existingDocumentSend.mediaAssetId) {
      return NextResponse.json({ error: "Document must be attached before sending" }, { status: 409 });
    }

    const deliveryAttemptId = crypto.randomUUID();
    const claimed = await claimDocumentDeliveryAttempt({
      deliveryAttemptId,
      documentSendId: existingDocumentSend.id,
      workspaceId: auth.session.workspaceId,
    });
    if (!claimed) {
      return NextResponse.json({ error: "Document delivery was already claimed" }, { status: 409 });
    }

    let publishedMediaAsset: Awaited<ReturnType<typeof publishWorkspaceMedia>> = null;
    try {
      publishedMediaAsset = await publishWorkspaceMedia(
        existingDocumentSend.mediaAssetId,
        auth.session,
        { accessMode: "reuse", expiresInSeconds: botDocumentAttemptShareTtlSeconds },
      );
    } catch {
      await updateDocumentDeliveryAttempt({
        deliveryAttemptId,
        documentSendId: existingDocumentSend.id,
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

    const publicDocumentUrl = publishedMediaAsset
      ? toPublicUrl(getPublicMediaUrl(publishedMediaAsset, request.url), request.url)
      : null;
    if (!(publishedMediaAsset?.publicShareId && publishedMediaAsset.publicShareExpiresAt && publicDocumentUrl)) {
      const publicShareRevocationState = publishedMediaAsset?.publicShareId
        ? await revokeDocumentAttemptShare({
            assetId: existingDocumentSend.mediaAssetId,
            publicShareId: publishedMediaAsset.publicShareId,
            workspaceId: auth.session.workspaceId,
          })
        : "not_required";
      await updateDocumentDeliveryAttempt({
        deliveryAttemptId,
        documentSendId: existingDocumentSend.id,
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
      documentSendId: existingDocumentSend.id,
      metadata: {
        deliveryAttemptState: "in_flight",
        publicShareExpiresAt: publishedMediaAsset.publicShareExpiresAt,
        publicShareId: publishedMediaAsset.publicShareId,
      },
      status: "sending",
      workspaceId: auth.session.workspaceId,
    });
    if (!publicationTracked) {
      await revokeDocumentAttemptShare({
        assetId: existingDocumentSend.mediaAssetId,
        publicShareId: publishedMediaAsset.publicShareId,
        workspaceId: auth.session.workspaceId,
      });
      return NextResponse.json({ error: "Document delivery claim was lost" }, { status: 409 });
    }

    let delivery: Awaited<ReturnType<typeof sendBotDocument>>;
    try {
      delivery = await sendBotDocument({
        channel: existingDocumentSend.channel,
        documentName: existingDocumentSend.mediaAssetName ?? existingDocumentSend.documentName,
        documentUrl: publicDocumentUrl,
        idempotencyKey: `bot-document-send:${existingDocumentSend.id}`,
        mediaMimeType: existingDocumentSend.mediaAssetMimeType,
        recipientEmail: existingDocumentSend.contactEmail ?? customerData.email,
        recipientName: existingDocumentSend.contactName ?? customerData.name,
        recipientPhone: existingDocumentSend.contactPhone ?? customerData.phone,
      });
    } catch {
      const publicShareRevocationState = await revokeDocumentAttemptShare({
        assetId: existingDocumentSend.mediaAssetId,
        publicShareId: publishedMediaAsset.publicShareId,
        workspaceId: auth.session.workspaceId,
      });
      await updateDocumentDeliveryAttempt({
        deliveryAttemptId,
        documentSendId: existingDocumentSend.id,
        metadata: {
          deliveryAttemptFinishedAt: new Date().toISOString(),
          deliveryAttemptState: "failed",
          deliveryErrorCode: "provider_exception",
          publicShareRevokedAt: new Date().toISOString(),
          publicShareRevocationState,
        },
        status: "failed",
        workspaceId: auth.session.workspaceId,
      });
      return NextResponse.json({ error: "Document provider failed" }, { status: 502 });
    }
    const nextStatus = delivery.status;
    const sentAt = delivery.status === "sent" ? new Date().toISOString() : null;

    const publicShareRevokedAt = delivery.status === "sent" ? null : new Date().toISOString();
    const publicShareRevocationState = publicShareRevokedAt
      ? await revokeDocumentAttemptShare({
          assetId: existingDocumentSend.mediaAssetId,
          publicShareId: publishedMediaAsset.publicShareId,
          workspaceId: auth.session.workspaceId,
        })
      : "not_required";
    const publicShareExtension = sentAt
      ? await extendSentDocumentShare({
          assetId: existingDocumentSend.mediaAssetId,
          publicShareId: publishedMediaAsset.publicShareId,
          workspaceId: auth.session.workspaceId,
        })
      : { expiresAt: null, state: "not_required" as const };
    const persistedDelivery = toPersistedDocumentDelivery(delivery);

    const deliveryUpdated = await updateDocumentDeliveryAttempt({
      deliveryAttemptId,
      documentSendId: existingDocumentSend.id,
      metadata: {
        consentDecision,
        deliveredAt: sentAt,
        delivery: persistedDelivery,
        deliveryAttemptFinishedAt: new Date().toISOString(),
        deliveryAttemptState: delivery.status === "sent" ? "sent" : "failed",
        lastDeliveryAttemptAt: new Date().toISOString(),
        publicShareExpiresAt: publicShareExtension.expiresAt ?? publishedMediaAsset.publicShareExpiresAt,
        publicShareExtensionState: publicShareExtension.state,
        publicShareId: publishedMediaAsset.publicShareId,
        publicShareRevokedAt,
        publicShareRevocationState,
      },
      sentAt,
      status: nextStatus,
      workspaceId: auth.session.workspaceId,
    });
    if (!deliveryUpdated) {
      return NextResponse.json({ error: "Document delivery result could not be persisted" }, { status: 503 });
    }

    if (delivery.deliveryMode === "email" && delivery.recipient) {
      await insertNewsletterSend({
        session: auth.session,
        campaignId: null,
        contactId: null,
        deliveryPurpose: "bot_document",
        provider: delivery.provider,
        providerMessageId: delivery.messageId ?? null,
        toEmail: delivery.recipient,
        subject: `Ihr angefragtes Dokument: ${existingDocumentSend.mediaAssetName ?? existingDocumentSend.documentName}`,
        status: delivery.status,
        error: delivery.error ? "provider_delivery_failed" : null,
        metadata: {
          botDocumentSendId: existingDocumentSend.id,
          channel: existingDocumentSend.channel,
          consentDecision,
          deliveryMode: delivery.deliveryMode,
          source: "bot_action_outbox",
        },
        sentAt,
      });
    }

    const updatedDocumentSend = await queryOne<BotDocumentSendRow>(
      `${getDocumentSendSelect(`
        where bds.id = $1
          and bds.workspace_id = $2
      `)}
      limit 1`,
      [id, auth.session.workspaceId],
    );

    await writeAuditLog({
      session: auth.session,
      action: "bot.document_send.provider_delivery",
      entityId: existingDocumentSend.id,
      entityType: "bot_document_send",
      after: {
        delivery: persistedDelivery,
        status: nextStatus,
      },
    });

    return NextResponse.json({
      delivery,
      documentSend: updatedDocumentSend ? toClientDocumentSend(updatedDocumentSend) : null,
      status: nextStatus,
    });
  }

  if (type === "meeting_booking" && (action === "confirm" || action === "cancel")) {
    if (action === "confirm") {
      const launchScope = evaluateLaunchScope("calendarProviderMutation");
      if (!launchScope.allowed) {
        return NextResponse.json(
          { code: launchScope.code, error: "calendar_provider_mutation_launch_off", ok: false },
          { headers: { "Cache-Control": "private, no-store" }, status: 503 },
        );
      }
    }

    let providerResult: unknown = null;
    const existingMeetingBooking = await queryOne<BotMeetingBookingRow>(
      `${getMeetingBookingSelect(`
        where id = $1
          and workspace_id = $2
          and source in ('bot_approval', 'bot_autonomy', 'bot')
      `)}
      limit 1`,
      [id, auth.session.workspaceId],
    );

    if (!existingMeetingBooking) {
      return NextResponse.json({ error: "Meeting action not found" }, { status: 404 });
    }

    if (action === "confirm") {
      const decision = evaluateBotAction({
        action: "meeting_book",
        controls,
        meeting: {
          contactEmail: existingMeetingBooking.contactEmail,
          contactName: existingMeetingBooking.contactName,
          selectedDate: existingMeetingBooking.startsAt.slice(0, 10),
          slot: existingMeetingBooking.startsAt,
          slug: existingMeetingBooking.slug,
        },
        risk: "high",
      });

      if (!decision.allowed || decision.mode === "test") {
        await writeAuditLog({
          session: auth.session,
          action: "bot.meeting_booking.manual_policy_decision",
          entityId: existingMeetingBooking.id,
          entityType: "meeting_booking",
          after: {
            decision,
            meetingBooking: existingMeetingBooking,
            status: decision.mode === "test" ? "test" : "blocked",
          },
        });

        return NextResponse.json({
          decision,
          meetingBooking: existingMeetingBooking,
          status: decision.mode === "test" ? "test" : "blocked",
        }, { status: decision.mode === "block" ? 409 : 202 });
      }

      const confirmation = await confirmMeetingBooking({
        bookingId: id,
        requestUrl: request.url,
        session: auth.session,
      });

      if (!confirmation.ok) {
        return NextResponse.json(confirmation, { status: 502 });
      }

      const delivery = confirmation.finalConfirmationQueued
        ? await processDueMeetingNotifications({
            jobIds: confirmation.finalConfirmationJobId ? [confirmation.finalConfirmationJobId] : [],
          })
        : { checked: 0, failed: 0, sent: 0 };

      providerResult = { confirmation, delivery };
    } else {
      await queryOne<{ id: string }>(
        `
          update meeting_bookings
          set status = 'cancelled',
              metadata = metadata || $3::jsonb,
              updated_at = now()
          where id = $1
            and workspace_id = $2
            and source in ('bot_approval', 'bot_autonomy', 'bot')
          returning id
        `,
        [
          id,
          auth.session.workspaceId,
          JSON.stringify({
            cancelledAt: new Date().toISOString(),
            cancelledBy: "bot_action_outbox",
          }),
        ],
      );

      await queryOne<{ id: string }>(
        `
          update meeting_notification_jobs
          set status = 'cancelled', updated_at = now()
          where booking_id = $1 and status in ('queued', 'retry', 'sending')
          returning id
        `,
        [id],
      );
      providerResult = { status: "cancelled" };
    }

    const meetingBooking = await queryOne<BotMeetingBookingRow>(
      `${getMeetingBookingSelect(`
        where id = $1
          and workspace_id = $2
          and source in ('bot_approval', 'bot_autonomy', 'bot')
      `)}
      limit 1`,
      [id, auth.session.workspaceId],
    );

    if (!meetingBooking) {
      return NextResponse.json({ error: "Meeting action not found" }, { status: 404 });
    }

    await writeAuditLog({
      session: auth.session,
      action: `bot.meeting_booking.${action}`,
      entityId: meetingBooking.id,
      entityType: "meeting_booking",
      after: {
        meetingBooking,
        providerResult,
      },
    });

    return NextResponse.json({ meetingBooking, providerResult, status: meetingBooking.status });
  }

  return NextResponse.json({ error: "Unsupported bot action" }, { status: 400 });
}
