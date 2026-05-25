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
