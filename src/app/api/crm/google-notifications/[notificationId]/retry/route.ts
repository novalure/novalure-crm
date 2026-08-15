import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  processDueGoogleNotifications,
  retryGoogleNotificationJob,
} from "@/lib/db/google-notification-repositories";

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const { notificationId } = await context.params;
  const retry = await retryGoogleNotificationJob({
    notificationId,
    session: auth.session,
  });

  if (!retry.ok || !retry.jobId) {
    return NextResponse.json({ error: retry.error ?? "retry_failed" }, { status: 400 });
  }

  const processed = await processDueGoogleNotifications({
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
