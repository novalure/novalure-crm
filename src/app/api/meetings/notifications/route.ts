import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { hasDatabaseUrl } from "@/lib/db/client";
import { insertNewsletterSend, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getNewsletterProviderStatus, sendNewsletterEmail } from "@/lib/integrations/resend";
import { evaluateLaunchScope } from "@/lib/launch-scope";

type NotificationInput = {
  body?: string;
  kind?: "confirmation" | "reminder" | "follow_up";
  subject?: string;
  title?: string;
  to?: string;
  tokens?: Record<string, string>;
};

const EMAIL_PATTERN = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const MAX_BODY_LENGTH = 20_000;
const MAX_QA_RECIPIENTS = 20;
const MAX_SUBJECT_LENGTH = 200;
const QA_IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

function normalizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? email : "";
}

function getQaEmailAllowlist() {
  const raw = String(process.env.NOVALURE_QA_EMAIL_ALLOWLIST ?? "").trim();
  if (!raw) return null;

  const entries = raw.split(/[\s,;]+/).filter(Boolean);
  if (!entries.length || entries.length > MAX_QA_RECIPIENTS) return null;

  const normalized = entries.map(normalizeEmail);
  if (normalized.some((email) => !email)) return null;

  return new Set(normalized);
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function recipientHash(workspaceId: string, email: string) {
  return createHash("sha256").update(`${workspaceId}:${email}`).digest("hex");
}

function buildQaIdempotencyKey(input: {
  body: string;
  kind: string;
  recipient: string;
  subject: string;
  workspaceId: string;
}) {
  const window = Math.floor(Date.now() / QA_IDEMPOTENCY_WINDOW_MS);
  const digest = createHash("sha256")
    .update([input.workspaceId, input.recipient, input.kind, input.subject, input.body, window].join("\u0000"))
    .digest("hex");

  return `meeting-qa-test:${digest}`;
}

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
    <div style="background:#faf9f7;padding:32px 16px;font-family:Figtree,Arial,sans-serif;color:#33302b">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e3ded5;border-radius:8px;padding:28px;box-shadow:0 18px 60px rgba(51,48,43,.08)">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#1e4fc2;font-weight:800">Novalure Meeting</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;color:#33302b">${escapeHtml(input.title)}</h1>
        <div style="font-size:15px;line-height:1.65;color:#6f6a63">${body}</div>
      </div>
    </div>
  `;
}

export async function POST(request: Request) {
  if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) {
    return NextResponse.json(
      { error: "customer_communication_provider_launch_off", external: false, ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }

  const auth = await requirePermission(request, "newsletter:send");
  if (!auth.ok) return auth.response;

  let body: NotificationInput;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    body = parsed as NotificationInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.kind !== undefined && !["confirmation", "reminder", "follow_up"].includes(body.kind)) {
    return NextResponse.json({ error: "Invalid notification kind" }, { status: 400 });
  }

  const to = normalizeEmail(body.to);
  const tokens = body.tokens;
  if (
    tokens !== undefined &&
    (typeof tokens !== "object" || tokens === null || Array.isArray(tokens) || Object.keys(tokens).length > 30)
  ) {
    return NextResponse.json({ error: "Invalid notification tokens" }, { status: 400 });
  }
  const normalizedTokens = Object.fromEntries(
    Object.entries(tokens ?? {}).filter(
      ([token, replacement]) =>
        token.length > 0 && token.length <= 100 && typeof replacement === "string" && replacement.length <= 500,
    ),
  );
  if (Object.keys(normalizedTokens).length !== Object.keys(tokens ?? {}).length) {
    return NextResponse.json({ error: "Invalid notification tokens" }, { status: 400 });
  }

  const kind = body.kind === "reminder" || body.kind === "follow_up" ? body.kind : "confirmation";
  const subject = resolveTokens(String(body.subject ?? "").trim(), normalizedTokens);
  const title = resolveTokens(String(body.title ?? subject).trim(), normalizedTokens);
  const resolvedBody = resolveTokens(String(body.body ?? "").trim(), normalizedTokens);

  if (
    !to ||
    !subject ||
    !resolvedBody ||
    subject.length > MAX_SUBJECT_LENGTH ||
    title.length > MAX_SUBJECT_LENGTH ||
    resolvedBody.length > MAX_BODY_LENGTH
  ) {
    return NextResponse.json({ error: "Recipient, subject and body are required" }, { status: 400 });
  }

  const qaAllowlist = getQaEmailAllowlist();
  if (!qaAllowlist) {
    return NextResponse.json(
      { error: "QA email allowlist is not configured", external: false, ok: false },
      { status: 503 },
    );
  }
  if (!qaAllowlist.has(to)) {
    return NextResponse.json(
      { error: "Recipient is not approved for external QA email", external: false, ok: false },
      { status: 403 },
    );
  }

  const provider = getNewsletterProviderStatus();
  if (!provider.configured || !provider.external) {
    return NextResponse.json(
      {
        error: provider.reason ?? "External email provider is not ready",
        external: false,
        ok: false,
        provider: { configured: provider.configured, external: provider.external, provider: provider.provider },
        send: { error: provider.reason, messageId: null, provider: provider.provider, status: "failed" },
      },
      { status: 503 },
    );
  }
  if (!hasDatabaseUrl() || !isUuid(auth.session.workspaceId)) {
    return NextResponse.json(
      { error: "Notification audit persistence is unavailable", external: false, ok: false },
      { status: 503 },
    );
  }

  const qaRecipientHash = recipientHash(auth.session.workspaceId, to);
  const result = await sendNewsletterEmail({
    html: textToEmailHtml({ body: resolvedBody, title }),
    idempotencyKey: buildQaIdempotencyKey({
      body: resolvedBody,
      kind,
      recipient: to,
      subject,
      workspaceId: auth.session.workspaceId,
    }),
    purpose: "meeting_qa_test",
    subject,
    to,
  });

  const sendId = await insertNewsletterSend({
    session: auth.session,
    deliveryPurpose: "meeting_qa_test",
    provider: result.provider,
    providerMessageId: result.messageId ?? null,
    toEmail: to,
    subject,
    status: result.status,
    error: result.error ?? null,
    metadata: {
      kind,
      providerConfigured: provider.configured,
      qaRecipientHash,
      source: "meeting_notification_qa_test",
    },
    sentAt: result.status === "sent" ? new Date().toISOString() : null,
  });

  await writeAuditLog({
    session: auth.session,
    action: "meeting_notification.test_requested",
    entityType: "newsletter_send",
    entityId: sendId,
    after: {
      external: result.status === "sent",
      kind,
      provider: result.provider,
      recipientHash: qaRecipientHash,
      status: result.status,
    },
  });

  return NextResponse.json(
    {
      external: result.status === "sent",
      ok: result.status === "sent",
      provider: { configured: provider.configured, external: provider.external, provider: provider.provider },
      recipient: maskEmail(to),
      recorded: Boolean(sendId),
      send: {
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
        id: sendId,
        messageId: result.messageId ?? null,
        provider: result.provider,
        status: result.status,
      },
    },
    { status: result.status === "sent" ? 200 : 502 },
  );
}
