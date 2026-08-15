import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  listTeamsNotificationJobs,
  listTeamsNotificationTargets,
  processDueTeamsNotifications,
  queueCustomerAccessRiskAlerts,
  queueLeadSlaDueSoonAlerts,
  queueLeadSlaOverdueAlerts,
  upsertTeamsNotificationTarget,
  type TeamsNotificationStatus,
} from "@/lib/db/teams-notification-repositories";

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

function getStatus(url: URL): TeamsNotificationStatus | "all" {
  const status = url.searchParams.get("status");
  return status === "queued" ||
    status === "pending_config" ||
    status === "sending" ||
    status === "sent" ||
    status === "failed" ||
    status === "cancelled"
    ? status
    : "all";
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const [targets, jobs] = await Promise.all([
    listTeamsNotificationTargets({ session: auth.session }),
    listTeamsNotificationJobs({
      limit: getLimit(url),
      session: auth.session,
      status: getStatus(url),
    }),
  ]);

  return NextResponse.json({
    jobs,
    targets,
  });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "target";

  if (operation === "target") {
    const target = typeof input.target === "object" && input.target ? input.target as Record<string, unknown> : input;
    const result = await upsertTeamsNotificationTarget({
      session: auth.session,
      target,
    });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    return NextResponse.json(result);
  }

  if (operation === "queue_sla_overdue") {
    const result = await queueLeadSlaOverdueAlerts({
      limit: typeof input.limit === "number" ? input.limit : 25,
      session: auth.session,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (operation === "queue_sla_due_soon") {
    const result = await queueLeadSlaDueSoonAlerts({
      limit: typeof input.limit === "number" ? input.limit : 25,
      session: auth.session,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (operation === "queue_customer_access_risk") {
    const result = await queueCustomerAccessRiskAlerts({
      limit: typeof input.limit === "number" ? input.limit : 25,
      session: auth.session,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (operation === "process") {
    const result = await processDueTeamsNotifications({
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
