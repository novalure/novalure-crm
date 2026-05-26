import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { archiveContactRecord, upsertContactRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getWriteErrorStatus(reason: string) {
  if (
    reason.includes("required") ||
    reason.includes("Invalid") ||
    reason.includes("Duplicate") ||
    reason.includes("too long") ||
    reason.includes("Valid project") ||
    reason.includes("Valid organization")
  ) {
    return 400;
  }

  if (reason.includes("not available in this workspace")) {
    return 403;
  }

  if (reason.includes("not found")) {
    return 404;
  }

  return 503;
}

function getContactIdFromRequest(request: Request, body?: Record<string, unknown> | null) {
  const url = new URL(request.url);
  const idFromQuery = url.searchParams.get("id") ?? url.searchParams.get("contactId");
  const idFromBody = body?.contactId ?? body?.id;

  return typeof idFromBody === "string" ? idFromBody : idFromQuery ?? "";
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const contact = typeof input.contact === "object" && input.contact ? input.contact as Record<string, unknown> : input;
  const result = await upsertContactRecord({ contact, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
  }

  return NextResponse.json({ contact: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (input.action === "archive") {
    const result = await archiveContactRecord({
      contactId: getContactIdFromRequest(request, input),
      session: auth.session,
    });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
    }

    return NextResponse.json({ archived: true, contactId: result.data.id, persisted: true });
  }

  const contact = typeof input.contact === "object" && input.contact ? input.contact as Record<string, unknown> : input;
  const result = await upsertContactRecord({ contact, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
  }

  return NextResponse.json({ contact: result.data, persisted: true });
}

export async function DELETE(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> | null = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const payload = await readJson(request);
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    body = payload as Record<string, unknown>;
  }

  const result = await archiveContactRecord({
    contactId: getContactIdFromRequest(request, body),
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
  }

  return NextResponse.json({ archived: true, contactId: result.data.id, persisted: true });
}
