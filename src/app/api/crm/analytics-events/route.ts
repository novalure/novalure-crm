import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  crmAnalyticsEventTypes,
  listCrmAnalyticsEvents,
} from "@/lib/db/analytics-event-repositories";

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 100);
  return Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100;
}

function getEventTypes(url: URL) {
  return [
    ...url.searchParams.getAll("eventType"),
    ...String(url.searchParams.get("eventTypes") ?? "").split(","),
  ].map((value) => value.trim()).filter(Boolean);
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const events = await listCrmAnalyticsEvents({
    eventTypes: getEventTypes(url),
    from: url.searchParams.get("from"),
    limit: getLimit(url),
    module: url.searchParams.get("module"),
    projectId: url.searchParams.get("projectId"),
    source: url.searchParams.get("source"),
    to: url.searchParams.get("to"),
    workspaceId: auth.session.workspaceId,
  });

  return NextResponse.json({
    eventTypes: crmAnalyticsEventTypes,
    events,
    filters: {
      eventTypes: getEventTypes(url),
      from: url.searchParams.get("from"),
      module: url.searchParams.get("module"),
      projectId: url.searchParams.get("projectId"),
      source: url.searchParams.get("source"),
      to: url.searchParams.get("to"),
    },
    source: "database",
  });
}
