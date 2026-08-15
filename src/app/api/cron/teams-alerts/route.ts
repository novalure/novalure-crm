import {
  processDueTeamsNotifications,
  queueScheduledCriticalTeamsAlerts,
} from "@/lib/db/teams-notification-repositories";

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

  const queued = await queueScheduledCriticalTeamsAlerts({
    limitPerWorkspace: 25,
    workspaceLimit: 50,
  });
  const processed = await processDueTeamsNotifications({ limit: 50 });

  return Response.json({
    ok: true,
    processed,
    queued,
  });
}
