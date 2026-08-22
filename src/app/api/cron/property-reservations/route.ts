import { expireOverduePropertyReservations } from "@/lib/db/reservation-repositories";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const maxDuration = 60;

function getLimit(request: Request) {
  const value = new URL(request.url).searchParams.get("limit");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(1, Math.round(parsed))) : 250;
}

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const launchScope = evaluateLaunchScope("propertyReservationRelationshipSync");
  if (!launchScope.allowed) {
    return Response.json(
      { code: launchScope.code, error: "Property reservation synchronization is outside launch scope", ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }
  const run = createCronRun({ route: "property-reservations" });
  if (areQueueWorkersPaused()) {
    return Response.json({ ok: true, paused: true, runId: run.runId });
  }

  const result = await expireOverduePropertyReservations({
    limit: getLimit(request),
    source: "cron/property-reservations",
  });

  return Response.json({
    durationMs: run.durationMs(),
    ok: true,
    runId: run.runId,
    ...result,
  });
}
