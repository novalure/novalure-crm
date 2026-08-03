import { expireOverduePropertyReservations } from "@/lib/db/reservation-repositories";

export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== "production";

  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function getLimit(request: Request) {
  const value = new URL(request.url).searchParams.get("limit");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.round(parsed))) : 50;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const result = await expireOverduePropertyReservations({
    limit: getLimit(request),
    source: "cron/property-reservations",
  });

  return Response.json({
    ok: true,
    ...result,
    durationMs: Date.now() - startedAt,
  });
}
