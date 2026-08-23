import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  listGoogleNotificationJobs,
  listGoogleNotificationTargets,
  processDueGoogleNotifications,
  queueGoogleCustomerAccessRiskAlerts,
  queueGoogleLeadSlaOverdueAlerts,
  runGoogleNotificationTargetTestSinkHealthcheck,
  upsertGoogleNotificationTarget,
  type GoogleNotificationStatus,
} from "@/lib/db/google-notification-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 50;
}

function getStatus(url: URL): GoogleNotificationStatus | "all" {
  const status = url.searchParams.get("status");
  return status === "queued" ||
    status === "retry" ||
    status === "pending_config" ||
    status === "sending" ||
    status === "sent" ||
    status === "failed" ||
    status === "dead_letter" ||
    status === "cancelled"
    ? status
    : "all";
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const [targets, jobs] = await Promise.all([
    listGoogleNotificationTargets({ session: auth.session }),
    listGoogleNotificationJobs({
      limit: getLimit(url),
      session: auth.session,
      status: getStatus(url),
    }),
  ]);

  return NextResponse.json({ jobs, targets });
}

export async function POST(request: Request) {
  const launchScope = evaluateLaunchScope("googleNotificationDelivery");
  if (!launchScope.allowed) {
    return NextResponse.json(
      { code: launchScope.code, error: "google_notification_delivery_launch_off" },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }

  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "target";

  if (operation === "target") {
    if (!auth.session.productPermissions.includes("settings:manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const target = typeof input.target === "object" && input.target ? input.target as Record<string, unknown> : input;
    const result = await upsertGoogleNotificationTarget({
      session: auth.session,
      target,
    });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    return NextResponse.json(result);
  }

  if (operation === "healthcheck" || operation === "reconnect") {
    if (!auth.session.productPermissions.includes("settings:manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const targetId = typeof input.targetId === "string" ? input.targetId : "";
    const result = await runGoogleNotificationTargetTestSinkHealthcheck({
      session: auth.session,
      targetId,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  if (operation === "queue_sla_overdue") {
    const result = await queueGoogleLeadSlaOverdueAlerts({
      limit: typeof input.limit === "number" ? input.limit : 25,
      session: auth.session,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (operation === "queue_customer_access_risk") {
    const result = await queueGoogleCustomerAccessRiskAlerts({
      limit: typeof input.limit === "number" ? input.limit : 25,
      session: auth.session,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (operation === "process") {
    if (!auth.session.productPermissions.includes("settings:manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const result = await processDueGoogleNotifications({
      limit: typeof input.limit === "number" ? input.limit : 25,
      workspaceId: auth.session.workspaceId,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  return NextResponse.json({ error: "Unsupported operation" }, { status: 400 });
}

export async function PATCH(request: Request) {
  return POST(request);
}
