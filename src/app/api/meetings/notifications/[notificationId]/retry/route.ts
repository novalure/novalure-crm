import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { retryMeetingNotificationJob } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;

  const { notificationId } = await context.params;
  const result = await retryMeetingNotificationJob({
    notificationId,
    session: auth.session,
  });

  if (!result.ok || !result.jobId) {
    return NextResponse.json(result, { status: 404 });
  }

  const delivery = await processDueMeetingNotifications({ jobIds: [result.jobId] });

  return NextResponse.json({ ...result, delivery });
}
