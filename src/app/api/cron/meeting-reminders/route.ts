import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = createCronRun({ route: "meeting-reminders" });
  if (areQueueWorkersPaused()) {
    return Response.json({ ok: true, paused: true, runId: run.runId });
  }

  const result = await processDueMeetingNotifications({ limit: 25, shouldContinue: run.shouldContinue });

  return Response.json({
    durationMs: run.durationMs(),
    ok: true,
    runId: run.runId,
    ...result,
  });
}
