import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { confirmMeetingBooking } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { resolveBookingCorrelationId } from "@/lib/meetings/booking-lifecycle";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

export const maxDuration = 60;

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;

  const { bookingId } = await context.params;
  const correlationId = resolveBookingCorrelationId(request.headers.get("x-correlation-id"));
  const result = await confirmMeetingBooking({
    bookingId,
    correlationId,
    requestUrl: request.url,
    session: auth.session,
  });

  if (!result.ok) {
    const response = NextResponse.json(
      { ...result, error: result.error === "action_recovery_required" ? result.error : "calendar_sync_failed" },
      { status: result.error === "action_recovery_required" ? 503 : 502 },
    );
    response.headers.set("x-correlation-id", result.correlationId ?? correlationId);
    return response;
  }

  const delivery = result.finalConfirmationQueued
    ? await processDueMeetingNotifications({
        jobIds: result.finalConfirmationJobId ? [result.finalConfirmationJobId] : [],
      })
    : { checked: 0, failed: 0, sent: 0 };

  const response = NextResponse.json({ ...result, delivery });
  response.headers.set("x-correlation-id", result.correlationId ?? correlationId);
  return response;
}
