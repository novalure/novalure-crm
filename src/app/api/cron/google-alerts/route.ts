import {
  processDueGoogleNotifications,
  queueScheduledCriticalGoogleAlerts,
} from "@/lib/db/google-notification-repositories";

export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== "production";

  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadlineMs = startedAt + 45_000;
  const queued = await queueScheduledCriticalGoogleAlerts({
    deadlineMs: startedAt + 24_000,
    limitPerWorkspace: 10,
    workspaceLimit: 8,
  });
  const processed = await processDueGoogleNotifications({ deadlineMs, limit: 20 });

  return Response.json({
    ok: true,
    processed,
    queued,
    durationMs: Date.now() - startedAt,
  });
}
