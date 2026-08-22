import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { retryMeetingNotificationJob } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { evaluateLaunchScope } from "@/lib/launch-scope";

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;
  if (!evaluateLaunchScope("customerCommunicationProviderMutation").allowed) {
    return NextResponse.json(
      { error: "customer_communication_provider_launch_off", ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }

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
