import { NextResponse } from "next/server";
import { requirePermission, requirePermissionAndProductCapability } from "@/lib/auth/session";
import { runEditorPreflight } from "@/lib/db/editor-preflight-repositories";
import {
  getMeetingPageSettings,
  listMeetingPageSettings,
  upsertMeetingPageSettings,
  type MeetingPageSettings,
} from "@/lib/db/meeting-repositories";

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 25);
  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim();

  if (slug) {
    const page = await getMeetingPageSettings({ session: auth.session, slug });
    return NextResponse.json({
      page,
      source: page ? "database" : "fallback",
    });
  }

  const payload = await listMeetingPageSettings({
    limit: getLimit(url),
    session: auth.session,
  });

  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "calendar:manage");
  if (!auth.ok) return auth.response;

  let body: { page?: MeetingPageSettings };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.page?.slug) {
    return NextResponse.json({ error: "Missing meeting page" }, { status: 400 });
  }

  const preflight = await runEditorPreflight({
    editorType: "calendar",
    entityId: body.page.id ?? body.page.slug,
    payload: body.page,
    projectId: body.page.projectId ?? null,
    session: auth.session,
  });

  const result = await upsertMeetingPageSettings({
    page: body.page,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json(
      {
        error: result.reason ?? "Meeting settings could not be saved",
        persisted: false,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ page: result.page, persisted: true, preflight });
}
