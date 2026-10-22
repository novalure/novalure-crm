import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { isBookingMessageQaRuntime, canRunBookingReminderWhilePaused } from "@/lib/booking/message-runtime";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.headers.get("x-novalure-booking-qa") === "1" && !isBookingMessageQaRuntime()) {
    return Response.json({ error: "BOOKING_QA_WORKER_NOT_ENABLED" }, { status: 409 });
  }
  const run = createCronRun({ route: "meeting-reminders" });
  const legacyPaused = areQueueWorkersPaused();
  const productionBookingWorker = canRunBookingReminderWhilePaused();
  if (legacyPaused && !productionBookingWorker) {
    return Response.json({ ok: true, paused: true, runId: run.runId });
  }

  const result = await processDueMeetingNotifications({ limit: 25, shouldContinue: run.shouldContinue, legacyPaused });
  if (result.booking) {
    // Correlate the hosting scheduler's request log with durable mail outcomes.
    // A user-agent is diagnostic metadata, never authentication or trigger proof.
    console.info(JSON.stringify({ event: "booking.reminder.tick", runId: run.runId,
      cronUserAgent: request.headers.get("user-agent") === "vercel-cron/1.0",
      durationMs: run.durationMs(), legacyPaused,
      checked: result.booking.checked, accepted: result.booking.accepted,
      failed: result.booking.failed, uncertain: result.booking.uncertain, skipped: result.booking.skipped }));
  }

  return Response.json({
    durationMs: run.durationMs(),
    ok: true,
    runId: run.runId,
    ...result,
  });
}
