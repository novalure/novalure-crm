import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { isPropertyExportQaSinkEnabled } from "@/lib/property-export/provider-adapters";
import { processDuePropertyExports } from "@/lib/property-export/runner";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const launchScope = evaluateLaunchScope("propertyExportQueue");
  if (!launchScope.allowed) {
    return Response.json(
      {
        code: "property_export_queue_launch_off",
        error: launchScope.rule.reason,
        launchScopeCode: launchScope.code,
        ok: false,
      },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }
  const run = createCronRun({ route: "property-exports" });

  try {
    if (!isPropertyExportQaSinkEnabled()) {
      const response = Response.json(
        { code: "qa_sink_not_configured", ok: false, runId: run.runId },
        { headers: { "Cache-Control": "private, no-store" }, status: 503 },
      );
      run.fail();
      return response;
    }
    if (areQueueWorkersPaused()) {
      const response = Response.json({ ok: true, paused: true, runId: run.runId });
      run.succeed("paused");
      return response;
    }

    const processed = await processDuePropertyExports({ limit: 50, shouldContinue: run.shouldContinue });
    const response = Response.json({ ok: true, processed, runId: run.runId });
    run.succeed();
    return response;
  } catch (error) {
    run.fail();
    throw error;
  }
}
