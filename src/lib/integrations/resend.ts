export type NewsletterEmailResult = {
  provider: "resend" | "mock";
  status: "sent" | "failed" | "queued";
  messageId?: string | null;
  error?: string | null;
};

export type NewsletterProviderStatus = {
  configured: boolean;
  provider: "resend" | "mock";
  external: boolean;
  from: string;
  reason: string | null;
};

/** A transactional acceptance result is deliberately distinct from delivery. */
export type TransactionalEmailResult =
  | { outcome: "accepted"; messageId: string }
  | { outcome: "rejected" | "retryable" | "uncertain" | "unconfigured"; error: string };

export async function sendTransactionalEmail(input: {
  to: string; subject: string; html: string; text: string; idempotencyKey: string; replyTo?: string; bookingJobId?: string;
}, transport: typeof fetch = fetch): Promise<TransactionalEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || process.env.NOVALURE_EMAIL_FROM?.trim();
  if (!apiKey || !from) return { outcome: "unconfigured", error: "MAIL_PROVIDER_NOT_CONFIGURED" };
  try {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html, text: input.text, ...(input.replyTo ? { reply_to: input.replyTo } : {}), ...(input.bookingJobId ? { tags: [{ name: "booking_job_id", value: input.bookingJobId }] } : {}) }),
    });
    if (response.status === 429) return { outcome: "retryable", error: "MAIL_PROVIDER_RATE_LIMIT" };
    if (response.status >= 500) return { outcome: "uncertain", error: `MAIL_PROVIDER_HTTP_${response.status}` };
    if (!response.ok) return { outcome: "rejected", error: `MAIL_PROVIDER_HTTP_${response.status}` };
    const data = await response.json().catch(() => null) as { id?: unknown } | null;
    if (!data || typeof data.id !== "string" || !data.id) return { outcome: "uncertain", error: "MAIL_PROVIDER_ACCEPTANCE_UNKNOWN" };
    return { outcome: "accepted", messageId: data.id };
  } catch {
    // Request may have reached the provider. A durable reconciler must decide what follows.
    return { outcome: "uncertain", error: "MAIL_PROVIDER_OUTCOME_UNKNOWN" };
  }
}

export function getNewsletterProviderStatus(): NewsletterProviderStatus {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESEND_FROM ||
    process.env.NOVALURE_EMAIL_FROM ||
    "Novalure CRM <onboarding@resend.dev>";

  return {
    configured: Boolean(apiKey),
    provider: apiKey ? "resend" : "mock",
    external: Boolean(apiKey),
    from,
    reason: apiKey ? null : "RESEND_API_KEY is not configured",
  };
}

export async function sendNewsletterEmail(input: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  idempotencyKey?: string;
  replyTo?: string;
}): Promise<NewsletterEmailResult> {
  const providerStatus = getNewsletterProviderStatus();
  const apiKey = process.env.RESEND_API_KEY;
  const from = input.from || providerStatus.from;

  if (!apiKey) {
    return {
      provider: "mock",
      status: "queued",
      error: providerStatus.reason,
    };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        reply_to: input.replyTo,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!response.ok) {
      return {
        provider: "resend",
        status: "failed",
        messageId: data.id ?? null,
        error: data.message || `Resend returned ${response.status}`,
      };
    }

    return {
      provider: "resend",
      status: "sent",
      messageId: data.id ?? null,
    };
  } catch (error) {
    return {
      provider: "resend",
      status: "failed",
      error: error instanceof Error ? error.message : "Resend request failed",
    };
  }
}
