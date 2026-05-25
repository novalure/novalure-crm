import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { evaluateOutboundConsent } from "@/lib/db/consent-policy";
import { insertNewsletterSend, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getNewsletterProviderStatus, sendNewsletterEmail } from "@/lib/integrations/resend";

type NotificationInput = {
  body?: string;
  idempotencyKey?: string;
  kind?: "confirmation" | "reminder" | "follow_up";
  subject?: string;
  title?: string;
  to?: string;
  tokens?: Record<string, string>;
};

function resolveTokens(value: string, tokens: Record<string, string>) {
  return Object.entries(tokens).reduce(
    (current, [token, replacement]) => current.replaceAll(token, replacement),
    value,
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textToEmailHtml(input: { body: string; title: string }) {
  const body = escapeHtml(input.body)
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 14px">${paragraph.replaceAll("\n", "<br />")}</p>`)
    .join("");

  return `
    <div style="background:#f6f9fc;padding:32px 16px;font-family:Arial,sans-serif;color:#0f172a">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dbeafe;border-radius:12px;padding:28px">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#2563eb;font-weight:700">Novalure Meeting</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;color:#0f172a">${escapeHtml(input.title)}</h1>
        <div style="font-size:15px;line-height:1.65;color:#1e293b">${body}</div>
      </div>
    </div>
  `;
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "newsletter:send");
  if (!auth.ok) return auth.response;

  let body: NotificationInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = String(body.to ?? "").trim();
  const tokens = body.tokens ?? {};
  const subject = resolveTokens(String(body.subject ?? "").trim(), tokens);
  const title = resolveTokens(String(body.title ?? subject).trim(), tokens);
  const resolvedBody = resolveTokens(String(body.body ?? "").trim(), tokens);

  if (!to || !subject || !resolvedBody) {
    return NextResponse.json({ error: "Recipient, subject and body are required" }, { status: 400 });
  }

  const provider = getNewsletterProviderStatus();
  const consentDecision = await evaluateOutboundConsent({
    channel: "E-Mail",
    email: to,
    metadata: {
      kind: body.kind ?? "confirmation",
      source: "meeting_notification",
      subject,
    },
    purpose: "salesFollowUp",
    session: auth.session,
  });

  if (!consentDecision.allowed) {
    const sendId = await insertNewsletterSend({
      session: auth.session,
      provider: provider.provider,
      providerMessageId: null,
      toEmail: to,
      subject,
      status: "suppressed",
      error: consentDecision.reason,
      metadata: {
        consentDecision,
        kind: body.kind ?? "confirmation",
        providerConfigured: provider.configured,
        source: "meeting_notification",
      },
      sentAt: null,
    });

    await writeAuditLog({
      session: auth.session,
      action: "meeting_notification.consent_blocked",
      entityType: "newsletter_send",
      entityId: sendId,
      after: { consentDecision, status: "suppressed", to },
    });

    return NextResponse.json({
      consentDecision,
      ok: false,
      provider,
      send: {
        error: consentDecision.reason,
        id: sendId,
        messageId: null,
        provider: provider.provider,
        status: "suppressed",
      },
    }, { status: 409 });
  }

  const result = await sendNewsletterEmail({
    html: textToEmailHtml({ body: resolvedBody, title }),
    idempotencyKey: body.idempotencyKey,
    subject,
    to,
  });

  const sendId = await insertNewsletterSend({
    session: auth.session,
    provider: result.provider,
    providerMessageId: result.messageId ?? null,
    toEmail: to,
    subject,
    status: result.status,
    error: result.error ?? null,
    metadata: {
      consentDecision,
      kind: body.kind ?? "confirmation",
      providerConfigured: provider.configured,
      source: "meeting_notification",
    },
    sentAt: result.status === "sent" ? new Date().toISOString() : null,
  });

  await writeAuditLog({
    session: auth.session,
    action: "meeting_notification.test_requested",
    entityType: "newsletter_send",
    entityId: sendId,
    after: {
      kind: body.kind ?? "confirmation",
      provider: result.provider,
      status: result.status,
      to,
    },
  });

  return NextResponse.json(
    {
      ok: result.status !== "failed",
      provider,
      send: {
        error: result.error ?? null,
        id: sendId,
        messageId: result.messageId ?? null,
        provider: result.provider,
        status: result.status,
      },
    },
    { status: result.status === "failed" ? 502 : 200 },
  );
}
