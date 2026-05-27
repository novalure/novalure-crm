import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { listNoteRecords, upsertNoteRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getNoteWriteStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (reason.includes("required") || reason.includes("Invalid") || reason.includes("too long")) return 400;
  return 503;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const result = await listNoteRecords({
    contactId: url.searchParams.get("contactId"),
    leadId: url.searchParams.get("leadId"),
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getNoteWriteStatus(result.reason) });
  }

  return NextResponse.json({ notes: result.notes, persisted: true });
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const note = typeof input.note === "object" && input.note ? input.note as Record<string, unknown> : input;
  const result = await upsertNoteRecord({ note, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getNoteWriteStatus(result.reason) });
  }

  return NextResponse.json({ note: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  return POST(request);
}
