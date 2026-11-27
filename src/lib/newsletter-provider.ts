import { getNewsletterProviderStatus } from "@/lib/integrations/resend";

export type NewsletterDispatch = { to: string; from: string; replyTo?: string; subject: string; html: string; unsubscribeUrl?: string; idempotencyKey: string; reference?:{kind:'newsletter'|'newsletter_test'|'automation';id:string} };
export type NewsletterDispatchResult = { status: "accepted" | "failed" | "uncertain"; messageId?: string; error?: string };
export type NewsletterTransport = (message: NewsletterDispatch) => Promise<NewsletterDispatchResult>;
/** Provider acceptance is distinct from delivery. Unknown results are never automatically resent. */
export const dispatchApprovedNewsletter: NewsletterTransport = async message => {
  const status = getNewsletterProviderStatus();
  if (!status.configured || !process.env.RESEND_API_KEY) return { status: "failed", error: "Der Versanddienst ist nicht eingerichtet." };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": message.idempotencyKey },
      body: JSON.stringify({ to: [message.to], from: message.from, reply_to: message.replyTo || undefined, subject: message.subject, html: message.html,
        ...(message.reference?{tags:[{name:'novalure_kind',value:message.reference.kind},{name:'novalure_delivery',value:message.reference.id}]}:{}),
        ...(message.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${message.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}) }),
    });
    const body = await response.json().catch(() => ({})) as { id?: unknown; message?: unknown };
    if (response.ok && typeof body.id === "string" && body.id) return { status: "accepted", messageId: body.id };
    if (response.status >= 400 && response.status < 500) return { status: "failed", error: typeof body.message === "string" ? body.message.slice(0, 500) : `Versanddienst meldet ${response.status}.` };
    return { status: "uncertain", error: "Die Annahme durch den Versanddienst ist ungeklärt." };
  } catch { return { status: "uncertain", error: "Die Annahme durch den Versanddienst ist ungeklärt." }; }
};
