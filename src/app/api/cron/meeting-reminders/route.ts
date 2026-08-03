import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";

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
  const result = await processDueMeetingNotifications({ deadlineMs: startedAt + 45_000, limit: 20 });

  return Response.json({
    ok: true,
    ...result,
    durationMs: Date.now() - startedAt,
  });
}
