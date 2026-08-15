import {
  processDueGoogleNotifications,
  queueScheduledCriticalGoogleAlerts,
} from "@/lib/db/google-notification-repositories";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = createCronRun({ route: "google-alerts" });
  if (areQueueWorkersPaused()) {
    return Response.json({ ok: true, paused: true, runId: run.runId });
  }

  const queued = await queueScheduledCriticalGoogleAlerts({
    limitPerWorkspace: 25,
    shouldContinue: run.shouldContinue,
    workspaceLimit: 50,
  });
  const processed = run.shouldContinue()
    ? await processDueGoogleNotifications({ limit: 50, shouldContinue: run.shouldContinue })
    : { checked: 0, failed: 0, sent: 0 };

  return Response.json({
    durationMs: run.durationMs(),
    ok: true,
    processed,
    queued,
    runId: run.runId,
  });
}
