import {
  processDueGoogleNotifications,
  queueScheduledCriticalGoogleAlerts,
} from "@/lib/db/google-notification-repositories";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const launchScope = evaluateLaunchScope("googleNotificationDelivery");
  if (!launchScope.allowed) {
    return Response.json(
      { code: launchScope.code, error: "google_notification_delivery_launch_off", ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }
  const run = createCronRun({ route: "google-alerts" });
  try {
    if (areQueueWorkersPaused()) {
      const response = Response.json({ ok: true, paused: true, runId: run.runId });
      run.succeed("paused");
      return response;
    }

    const queued = await queueScheduledCriticalGoogleAlerts({
      limitPerWorkspace: 25,
      shouldContinue: run.shouldContinue,
      workspaceLimit: 50,
    });
    const processed = run.shouldContinue()
      ? await processDueGoogleNotifications({ limit: 50, shouldContinue: run.shouldContinue })
      : { checked: 0, failed: 0, sent: 0 };

    const response = Response.json({
      durationMs: run.durationMs(),
      ok: true,
      processed,
      queued,
      runId: run.runId,
    });
    run.succeed();
    return response;
  } catch (error) {
    run.fail();
    throw error;
  }
}
