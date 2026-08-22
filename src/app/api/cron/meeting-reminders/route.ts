import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) {
    return Response.json(
      { error: "customer_communication_provider_launch_off", ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
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
