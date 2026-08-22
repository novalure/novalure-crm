import { createHash } from "node:crypto";
import { evaluateLaunchScope } from "@/lib/launch-scope";

const EMAIL_PATTERN = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const PROVIDER_TIMEOUT_MS = 12_000;
const RESEND_API_URL = "https://api.resend.com/emails";

export type NewsletterEmailErrorCode =
  | "configuration"
  | "invalid_input"
  | "launch_off"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_rejected"
  | "provider_timeout"
  | "transient";

export type NewsletterEmailResult = {
  provider: "resend";
  status: "sent" | "failed" | "queued";
  messageId?: string | null;
  error?: string | null;
  errorCode?: NewsletterEmailErrorCode;
};

export type NewsletterProviderStatus = {
  configured: boolean;
  provider: "resend";
  external: boolean;
  from: string;
  reason: string | null;
};

export type EmailDeliveryPurpose =
  | "bot_document"
  | "meeting_notification"
  | "meeting_qa_test"
  | "newsletter"
  | "password_reset"
  | "workspace_invitation";

/**
 * Account-access mail is deliberately a separate transactional contract. All
 * customer-facing provider effects must pass their signed launch surface even
 * when a caller reaches this adapter without its route/repository guard.
 */
export function isEmailDeliveryPurposeLaunchEnabled(purpose: unknown) {
  if (purpose === "password_reset" || purpose === "workspace_invitation") return true;
  if (purpose === "newsletter") return evaluateLaunchScope("newsletterDelivery").allowed;
  if (
    purpose === "bot_document" ||
    purpose === "meeting_notification" ||
    purpose === "meeting_qa_test"
  ) {
    return evaluateLaunchScope("customerCommunicationProviderMutation").allowed;
  }

  return false;
}

function normalizeMailbox(value: string | undefined) {
  const mailbox = String(value ?? "").trim().toLowerCase();
  return EMAIL_PATTERN.test(mailbox) ? mailbox : "";
}

function normalizeApiKey(value: string | undefined) {
  const apiKey = String(value ?? "").trim();
  return /^re_[A-Za-z0-9_-]{8,}$/.test(apiKey) ? apiKey : "";
}

function normalizeSender(value: string | undefined) {
  const sender = String(value ?? "").trim();
  if (!sender || /[\r\n]/.test(sender)) return "";

  const bracketed = sender.match(/^(?:[^<>]{1,100}\s*)?<([^<>\s]+)>$/);
  const mailbox = normalizeMailbox(bracketed?.[1] ?? sender);
  if (!mailbox || mailbox.endsWith("@resend.dev")) return "";

  return sender;
}

function normalizeIdempotencyKey(value: string | undefined) {
  const key = String(value ?? "").trim();
  if (!key) return undefined;

  return `novalure:${createHash("sha256").update(key).digest("hex")}`;
}

function providerFailure(status: number): Pick<NewsletterEmailResult, "error" | "errorCode"> {
  if (status === 401 || status === 403) {
    return { error: "Email provider authentication failed", errorCode: "provider_auth" };
  }
  if (status === 429) {
    return { error: "Email provider rate limit reached", errorCode: "provider_rate_limit" };
  }
  if (status >= 500) {
    return { error: "Email provider temporarily unavailable", errorCode: "transient" };
  }
  return { error: "Email provider rejected the request", errorCode: "provider_rejected" };
}

export function getNewsletterProviderStatus(): NewsletterProviderStatus {
  const configuredApiKey = String(process.env.RESEND_API_KEY ?? "").trim();
  const apiKey = normalizeApiKey(configuredApiKey);
  const configuredFrom = String(process.env.RESEND_FROM ?? "").trim();
  const from = normalizeSender(configuredFrom);
  const reason = !apiKey
    ? configuredApiKey
      ? "RESEND_API_KEY is invalid"
      : "RESEND_API_KEY is not configured"
    : !configuredFrom
      ? "RESEND_FROM is not configured"
      : !from
        ? "RESEND_FROM must be a valid production sender"
        : null;
  const configured = reason === null;

  return {
    configured,
    provider: "resend",
    external: configured,
    from,
    reason,
  };
}

export async function sendNewsletterEmail(input: {
  to: string;
  subject: string;
  html: string;
  purpose: EmailDeliveryPurpose;
  from?: string;
  idempotencyKey?: string;
  replyTo?: string;
}): Promise<NewsletterEmailResult> {
  if (!isEmailDeliveryPurposeLaunchEnabled(input.purpose)) {
    return {
      provider: "resend",
      status: "failed",
      error: "Email delivery is disabled by launch policy",
      errorCode: "launch_off",
    };
  }

  const providerStatus = getNewsletterProviderStatus();
  const apiKey = normalizeApiKey(process.env.RESEND_API_KEY);

  if (!providerStatus.configured || !apiKey) {
    return {
      provider: "resend",
      status: "failed",
      error: providerStatus.reason ?? "Email provider is not configured",
      errorCode: "configuration",
    };
  }

  const to = normalizeMailbox(input.to);
  const requestedFrom = String(input.from ?? "").trim();
  const from = providerStatus.from;
  const replyTo = input.replyTo?.trim() ? normalizeMailbox(input.replyTo) : "";
  const subject = input.subject.trim();
  const html = input.html.trim();

  if (
    !to ||
    !from ||
    (requestedFrom && requestedFrom !== providerStatus.from) ||
    !subject ||
    !html ||
    (input.replyTo?.trim() && !replyTo)
  ) {
    return {
      provider: "resend",
      status: "failed",
      error: "Email request contains invalid sender, recipient, subject or content",
      errorCode: "invalid_input",
    };
  }

  try {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    const data = (await response.json().catch(() => ({}))) as { id?: unknown };

    if (!response.ok) {
      return {
        provider: "resend",
        status: "failed",
        ...providerFailure(response.status),
      };
    }

    const messageId = typeof data.id === "string" && data.id.trim() ? data.id.trim() : "";
    if (!messageId) {
      return {
        provider: "resend",
        status: "failed",
        error: "Email provider returned no delivery identifier",
        errorCode: "provider_rejected",
      };
    }

    return {
      provider: "resend",
      status: "sent",
      messageId,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      provider: "resend",
      status: "failed",
      error: timedOut ? "Email provider request timed out" : "Email provider request failed",
      errorCode: timedOut ? "provider_timeout" : "transient",
    };
  }
}
