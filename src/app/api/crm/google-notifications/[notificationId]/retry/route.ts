import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { reconcileGoogleNotificationJob } from "@/lib/db/google-notification-repositories";

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, {
    capability: "settings:manage",
    permission: "crm:write",
  });
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null) as { targetId?: unknown } | null;
  const targetId = typeof body?.targetId === "string" ? body.targetId : "";
  const { notificationId } = await context.params;
  const reconciliation = await reconcileGoogleNotificationJob({
    notificationId,
    session: auth.session,
    targetId,
  });

  if (!reconciliation.ok || !reconciliation.jobId) {
    return NextResponse.json(reconciliation, { status: reconciliation.state === "blocked" ? 409 : 400 });
  }

  return NextResponse.json({
    ok: true,
    jobId: reconciliation.jobId,
    state: reconciliation.state,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return POST(request, context);
}
