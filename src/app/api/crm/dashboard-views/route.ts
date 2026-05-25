import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { listDashboardViews, upsertDashboardView } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const payload = await listDashboardViews({ session: auth.session });
  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const result = await upsertDashboardView({
    filters: input.filters,
    id: typeof input.id === "string" ? input.id : undefined,
    isDefault: Boolean(input.isDefault),
    layout: Array.isArray(input.layout) ? input.layout : [],
    name: typeof input.name === "string" ? input.name : "",
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    session: auth.session,
    widgets: Array.isArray(input.widgets) ? input.widgets.map(String) : [],
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ persisted: true, view: result.data });
}
