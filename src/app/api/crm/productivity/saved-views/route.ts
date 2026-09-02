import { NextResponse } from "next/server";

import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  archiveSavedView,
  listSavedViews,
  saveSavedView,
} from "@/lib/db/list-productivity-repository";
import { crmEntityKinds, type CrmEntityKind } from "@/lib/list-query-state";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function entityType(value: unknown): CrmEntityKind | null {
  return typeof value === "string" && crmEntityKinds.includes(value as CrmEntityKind)
    ? value as CrmEntityKind
    : null;
}

function positiveInteger(value: unknown, fallback = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const type = entityType(url.searchParams.get("entityType"));
  if (!type) return NextResponse.json({ error: "Unsupported entityType" }, { headers: privateHeaders, status: 400 });

  try {
    const result = await listSavedViews({
      entityType: type,
      page: positiveInteger(url.searchParams.get("page")),
      pageSize: positiveInteger(url.searchParams.get("pageSize"), 25),
      session: auth.session,
    });
    return NextResponse.json(result, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Saved views are unavailable" }, { headers: privateHeaders, status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  const raw = await readJson(request);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid JSON" }, { headers: privateHeaders, status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const type = entityType(body.entityType);
  if (!type) return NextResponse.json({ error: "Unsupported entityType" }, { headers: privateHeaders, status: 400 });
  if (body.isShared === true && auth.session.role !== "owner" && auth.session.role !== "admin") {
    return NextResponse.json({ error: "Only workspace owners and admins can share views" }, { headers: privateHeaders, status: 403 });
  }

  const result = await saveSavedView({
    columnState: body.columnState,
    entityType: type,
    id: typeof body.id === "string" ? body.id : null,
    isShared: body.isShared === true,
    name: body.name,
    projectId: typeof body.projectId === "string" ? body.projectId : null,
    queryState: body.queryState,
    rowVersion: positiveInteger(body.rowVersion, 0),
    session: auth.session,
  });
  return result.ok
    ? NextResponse.json(result, { headers: privateHeaders, status: body.id ? 200 : 201 })
    : NextResponse.json(result, { headers: privateHeaders, status: result.error.includes("stale") ? 409 : 400 });
}

export async function PATCH(request: Request) {
  return POST(request);
}

export async function DELETE(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  const raw = await readJson(request);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid JSON" }, { headers: privateHeaders, status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const rowVersion = positiveInteger(body.rowVersion, 0);
  if (!id || !rowVersion) {
    return NextResponse.json({ error: "id and rowVersion are required" }, { headers: privateHeaders, status: 400 });
  }
  const result = await archiveSavedView({ id, rowVersion, session: auth.session });
  return result.ok
    ? NextResponse.json(result, { headers: privateHeaders })
    : NextResponse.json(result, { headers: privateHeaders, status: 409 });
}
