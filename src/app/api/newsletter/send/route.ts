import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { evaluateOutboundConsent } from "@/lib/db/consent-policy";
import { updateNewsletterCampaignStatus } from "@/lib/db/crm-write-repositories";
import { runEditorPreflight } from "@/lib/db/editor-preflight-repositories";
import {
  insertNewsletterSend,
  listNewsletterSends,
  upsertProviderConnection,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { getNewsletterProviderStatus, sendNewsletterEmail } from "@/lib/integrations/resend";

export const maxDuration = 60;

const newsletterUnsubscribeUrlToken = "{{NOVALURE_UNSUBSCRIBE_URL}}";
const resendUnsubscribeUrlToken = "{{{RESEND_UNSUBSCRIBE_URL}}}";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getRecipients(input: Record<string, unknown>) {
  if (Array.isArray(input.recipients)) {
    return input.recipients.map(String).map((value) => value.trim()).filter(Boolean);
  }

  return String(input.to ?? "").trim() ? [String(input.to).trim()] : [];
}

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 25);

  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function buildNewsletterUnsubscribeUrl(input: {
  campaignId?: string | null;
  email: string;
  language: string;
  request: Request;
  workspaceId: string;
}) {
  const unsubscribeUrl = new URL("/unsubscribe", input.request.url);

  unsubscribeUrl.searchParams.set("email", input.email);
  unsubscribeUrl.searchParams.set("workspaceId", input.workspaceId);
  unsubscribeUrl.searchParams.set("lang", input.language);

  if (input.campaignId) {
    unsubscribeUrl.searchParams.set("campaignId", input.campaignId);
  }

  return unsubscribeUrl.toString();
}

function withRecipientUnsubscribeUrl(html: string, unsubscribeUrl: string) {
  return html
    .replaceAll(newsletterUnsubscribeUrlToken, unsubscribeUrl)
    .replaceAll(resendUnsubscribeUrlToken, unsubscribeUrl);
}

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "newsletter:send", "newsletter:send");

  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const provider = getNewsletterProviderStatus();
  const sends = await listNewsletterSends({
    session: auth.session,
    limit: getLimit(url),
    status: url.searchParams.get("status"),
  });
  const providerConnection = await upsertProviderConnection({
    session: auth.session,
    provider: "resend",
    status: provider.configured ? "connected" : "not_configured",
    accountLabel: provider.from,
    scopes: provider.configured ? ["email.send"] : [],
    config: {
      from: provider.from,
      mode: provider.provider,
    },
  });

  return Response.json({
    source: "database",
    provider,
    providerConnection,
    counts: {
      sends: sends.length,
      sent: sends.filter((send) => send.status === "sent").length,
      queued: sends.filter((send) => send.status === "queued").length,
      failed: sends.filter((send) => send.status === "failed").length,
    },
    sends,
  });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermissionAndProductCapability(request, "newsletter:send", "newsletter:send");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const recipients = getRecipients(input);
  const subject = String(input.subject ?? "").trim();
  const html = String(input.html ?? input.body ?? "").trim();
  const campaignId = typeof input.campaignId === "string" ? input.campaignId : null;
  const provider = getNewsletterProviderStatus();
  const preflight = await runEditorPreflight({
    editorType: "newsletter",
    entityId: campaignId,
    payload: {
      ...input,
      html,
      providerConfigured: provider.configured,
      recipients,
      subject,
    },
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    session: auth.session,
  });

  if (preflight.status === "blocked") {
    return Response.json({ error: "Newsletter preflight blocked send", preflight }, { status: 409 });
  }

  if (!recipients.length || !subject || !html) {
    return Response.json({ error: copy.emailRecipientRequired }, { status: 400 });
  }

  const cappedRecipients = recipients.slice(0, 50);
  const sends = await Promise.all(
    cappedRecipients.map(async (recipient) => {
      const normalizedRecipient = normalizeEmail(recipient);
      const consentDecision = await evaluateOutboundConsent({
        channel: "Newsletter",
        contactId: typeof input.contactId === "string" ? input.contactId : null,
        email: normalizedRecipient,
        metadata: {
          campaignId,
          source: "newsletter_send_api",
          subject,
        },
        purpose: "newsletter",
        session: auth.session,
      });

      if (!consentDecision.allowed) {
        const sendId = await insertNewsletterSend({
          session: auth.session,
          campaignId,
          contactId: consentDecision.contactId ?? (typeof input.contactId === "string" ? input.contactId : null),
          provider: provider.provider,
          providerMessageId: null,
          toEmail: recipient,
          subject,
          status: "suppressed",
          error: null,
          metadata: {
            consentDecision,
            source: "api",
            skippedReason: `consent_${consentDecision.reason}`,
            providerConfigured: provider.configured,
          },
          sentAt: null,
        });

        return {
          sendId,
          to: recipient,
          provider: provider.provider,
          status: "suppressed" as const,
          messageId: null,
          error: consentDecision.reason,
          consentDecision,
        };
      }

      const unsubscribeUrl = buildNewsletterUnsubscribeUrl({
        campaignId,
        email: recipient,
        language,
        request,
        workspaceId: auth.session.workspaceId,
      });
      const result = await sendNewsletterEmail({
        to: recipient,
        subject,
        html: withRecipientUnsubscribeUrl(html, unsubscribeUrl),
        from: typeof input.from === "string" ? input.from : undefined,
        idempotencyKey:
          typeof input.idempotencyKey === "string"
            ? `${input.idempotencyKey}:${recipient}`
            : undefined,
        replyTo: typeof input.replyTo === "string" ? input.replyTo : undefined,
      });
      const sendId = await insertNewsletterSend({
        session: auth.session,
        campaignId,
        contactId: consentDecision.contactId ?? (typeof input.contactId === "string" ? input.contactId : null),
        provider: result.provider,
        providerMessageId: result.messageId ?? null,
        toEmail: recipient,
        subject,
        status: result.status,
        error: result.error ?? null,
        metadata: {
          consentDecision,
          source: "api",
          externalStatus: result.status,
          providerConfigured: provider.configured,
          unsubscribeUrl,
        },
        sentAt: result.status === "sent" ? new Date().toISOString() : null,
      });

      return {
        sendId,
        to: recipient,
        provider: result.provider,
        status: result.status,
        messageId: result.messageId ?? null,
        error: result.error ?? null,
      };
    }),
  );
  const connectionStatus =
    !provider.configured ? "not_configured" : sends.every((send) => send.status === "failed") ? "failed" : "connected";
  const providerConnection = await upsertProviderConnection({
    session: auth.session,
    provider: "resend",
    status: connectionStatus,
    accountLabel: provider.from,
    scopes: provider.configured ? ["email.send"] : [],
    config: {
      from: provider.from,
      lastStatuses: sends.map((send) => send.status),
    },
  });

  await writeAuditLog({
    session: auth.session,
    action: "newsletter.send.requested",
    entityType: "newsletter_send",
    after: { subject, count: sends.length, statuses: sends.map((send) => send.status) },
  });

  const hasFailedSend = sends.some((send) => send.status === "failed");
  const sentCount = sends.filter((send) => send.status === "sent").length;
  const suppressedCount = sends.filter((send) => send.status === "suppressed").length;

  await updateNewsletterCampaignStatus({
    campaignId,
    contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : undefined,
    metrics: {
      failed: sends.filter((send) => send.status === "failed").length,
      lastSendRequestedAt: new Date().toISOString(),
      provider: provider.provider,
      queued: sends.filter((send) => send.status === "queued").length,
      sent: sentCount,
      suppressed: suppressedCount,
    },
    recipients: cappedRecipients.length,
    session: auth.session,
    status: hasFailedSend ? "failed" : sentCount > 0 ? "gesendet" : "queued",
    subject,
  });

  return Response.json(
    {
      ok: !hasFailedSend,
      provider,
      providerConnection,
      persisted: sends.some((send) => Boolean(send.sendId)),
      sends,
    },
    { status: hasFailedSend ? 502 : 200 },
  );
}
