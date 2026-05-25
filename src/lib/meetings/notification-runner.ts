import {
  claimMeetingNotificationJob,
  listDueMeetingNotificationJobs,
  markMeetingNotificationJobFailed,
  markMeetingNotificationJobSent,
  renderMeetingNotificationTemplate,
} from "@/lib/db/meeting-repositories";
import { sendNewsletterEmail } from "@/lib/integrations/resend";

type ProcessResult = {
  checked: number;
  failed: number;
  sent: number;
};

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
    <div style="margin:0;padding:32px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dbeafe;border-radius:16px;padding:28px">
        <p style="margin:0 0 10px;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">Novalure Meeting</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25">${escapeHtml(input.title)}</h1>
        <div style="font-size:15px;line-height:1.65;color:#1e293b">${paragraphs}</div>
      </div>
    </div>
  `;
}

export async function processDueMeetingNotifications(
  input: { jobIds?: string[]; limit?: number } = {},
): Promise<ProcessResult> {
  const jobRefs = input.jobIds?.length
    ? input.jobIds.map((id) => ({ id }))
    : await listDueMeetingNotificationJobs(input.limit ?? 25);
  const result: ProcessResult = { checked: jobRefs.length, failed: 0, sent: 0 };

  for (const jobRef of jobRefs) {
    const job = await claimMeetingNotificationJob(jobRef.id);
    if (!job) continue;

    const rendered = renderMeetingNotificationTemplate({
      body: job.body,
      subject: job.subject,
      title: job.title,
      tokens: job.tokens,
    });

    const emailResult = await sendNewsletterEmail({
      html: textToEmailHtml(rendered),
      idempotencyKey: `meeting-notification-${job.id}`,
      subject: rendered.subject,
      to: job.recipientEmail,
    });

    if (emailResult.status === "failed") {
      result.failed += 1;
      await markMeetingNotificationJobFailed({
        error: emailResult.error || "Email provider failed",
        id: job.id,
      });
      continue;
    }

    result.sent += 1;
    await markMeetingNotificationJobSent({
      id: job.id,
      messageId: emailResult.messageId ?? null,
      provider: emailResult.provider,
    });
  }

  return result;
}
