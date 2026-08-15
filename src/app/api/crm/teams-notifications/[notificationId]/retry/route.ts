import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  processDueTeamsNotifications,
  retryTeamsNotificationJob,
} from "@/lib/db/teams-notification-repositories";

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const { notificationId } = await context.params;
  const retry = await retryTeamsNotificationJob({
    notificationId,
    session: auth.session,
  });

  if (!retry.ok || !retry.jobId) {
    return NextResponse.json({ error: retry.error ?? "retry_failed" }, { status: 400 });
  }

  const processed = await processDueTeamsNotifications({
    jobIds: [retry.jobId],
    workspaceId: auth.session.workspaceId,
  });

  return NextResponse.json({
    ok: true,
    jobId: retry.jobId,
    processed,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return POST(request, context);
}
