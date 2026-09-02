import {
  claimMeetingNotificationJob,
  listDueMeetingNotificationJobs,
  markMeetingNotificationJobFailed,
  markMeetingNotificationJobSent,
  renderMeetingNotificationTemplate,
} from "@/lib/db/meeting-repositories";
import { sendNewsletterEmail } from "@/lib/integrations/resend";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  classifyDeliveryError,
  createLeaseOwner,
  retryDelaySeconds,
  sanitizeJobError,
} from "@/lib/jobs/durable-queue";

type ProcessResult = {
  checked: number;
  failed: number;
  sent: number;
};

const MAX_NOTIFICATION_BATCH = 25;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textToEmailHtml(input: { body: string; title: string }) {
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 14px">${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`)
    .join("");

  return `
    <div style="margin:0;padding:32px;background:#faf9f7;font-family:Figtree,Arial,sans-serif;color:#33302b">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e3ded5;border-radius:8px;padding:28px;box-shadow:0 18px 60px rgba(51,48,43,.08)">
        <p style="margin:0 0 10px;color:#1e4fc2;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase">Novalure Meeting</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25">${escapeHtml(input.title)}</h1>
        <div style="font-size:15px;line-height:1.65;color:#6f6a63">${paragraphs}</div>
      </div>
    </div>
  `;
}

export async function processDueMeetingNotifications(
  input: { jobIds?: string[]; limit?: number; shouldContinue?: () => boolean } = {},
): Promise<ProcessResult> {
  const result: ProcessResult = { checked: 0, failed: 0, sent: 0 };
  if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) return result;

  const requestedJobIds = [...new Set(input.jobIds ?? [])].slice(0, MAX_NOTIFICATION_BATCH);
  const requestedLimit = Math.trunc(input.limit ?? MAX_NOTIFICATION_BATCH);
  const limit = Math.max(1, Math.min(MAX_NOTIFICATION_BATCH, requestedLimit || MAX_NOTIFICATION_BATCH));
  const jobRefs = requestedJobIds.length
    ? requestedJobIds.map((id) => ({ id }))
    : await listDueMeetingNotificationJobs(limit);

  for (const jobRef of jobRefs) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    result.checked += 1;
    const leaseOwner = createLeaseOwner("meeting-notification");
    const job = await claimMeetingNotificationJob({ id: jobRef.id, leaseOwner });
    if (!job?.leaseOwner) continue;

    const rendered = renderMeetingNotificationTemplate({
      body: job.body,
      subject: job.subject,
      title: job.title,
      tokens: job.tokens,
    });

    let emailResult: Awaited<ReturnType<typeof sendNewsletterEmail>>;
    try {
      emailResult = await sendNewsletterEmail({
        html: textToEmailHtml(rendered),
        idempotencyKey: `meeting-notification-${job.id}`,
        purpose: "meeting_notification",
        subject: rendered.subject,
        to: job.recipientEmail,
      });
    } catch (error) {
      const message = sanitizeJobError(error);
      result.failed += 1;
      await markMeetingNotificationJobFailed({
        category: classifyDeliveryError({ error }),
        error: message,
        id: job.id,
        leaseOwner: job.leaseOwner,
        retryDelaySeconds: retryDelaySeconds(job.attemptCount),
      });
      continue;
    }

    if (emailResult.status !== "sent") {
      result.failed += 1;
      await markMeetingNotificationJobFailed({
        category:
          emailResult.errorCode === "invalid_input"
            ? "provider_rejected"
            : emailResult.errorCode ?? classifyDeliveryError({ error: emailResult.error }),
        error: sanitizeJobError(emailResult.error || "Email provider failed"),
        id: job.id,
        leaseOwner: job.leaseOwner,
        retryDelaySeconds: retryDelaySeconds(job.attemptCount),
      });
      continue;
    }

    result.sent += 1;
    await markMeetingNotificationJobSent({
      id: job.id,
      leaseOwner: job.leaseOwner,
      messageId: emailResult.messageId ?? null,
      provider: emailResult.provider,
    });
  }

  return result;
}
