import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { confirmMeetingBooking } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

export const maxDuration = 60;

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;

  const { bookingId } = await context.params;
  const result = await confirmMeetingBooking({
    bookingId,
    requestUrl: request.url,
    session: auth.session,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }

  const delivery = result.finalConfirmationQueued
    ? await processDueMeetingNotifications({
        jobIds: result.finalConfirmationJobId ? [result.finalConfirmationJobId] : [],
      })
    : { checked: 0, failed: 0, sent: 0 };

  return NextResponse.json({ ...result, delivery });
}
