import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { archiveContactRecord, listArchivedContactRecords, restoreContactRecord, upsertContactRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getWriteErrorStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (normalizedReason.includes("active contact with this email")) return 409;
  if (normalizedReason.includes("already active")) return 409;

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

  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) {
    return 403;
  }

  if (reason.includes("not found")) {
    return 404;
  }

  return 503;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  if (url.searchParams.get("archived") !== "1") {
    return NextResponse.json({ error: "Unsupported contact query" }, { status: 400 });
  }
  const result = await listArchivedContactRecords({
    page: Number(url.searchParams.get("page") || 1),
    pageSize: Number(url.searchParams.get("pageSize") || 25),
    session: auth.session,
  });
  if (!result.persisted) return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
  return NextResponse.json(result.data);
}

function getContactIdFromRequest(request: Request, body?: Record<string, unknown> | null) {
  const url = new URL(request.url);
  const idFromQuery = url.searchParams.get("id") ?? url.searchParams.get("contactId");
  const idFromBody = body?.contactId ?? body?.id;

  return typeof idFromBody === "string" ? idFromBody : idFromQuery ?? "";
}

function withContactIdFromRequest(request: Request, contact: Record<string, unknown>) {
  if (typeof contact.id === "string" && contact.id.trim().length > 0) return contact;
  const id = getContactIdFromRequest(request);
  return id ? { ...contact, id } : contact;
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
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
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
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
  if (input.action === "restore") {
    const result = await restoreContactRecord({
      contactId: getContactIdFromRequest(request, input),
      session: auth.session,
    });
    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
    }
    return NextResponse.json({ contact: result.data, persisted: true, restored: true });
  }

  const contact = typeof input.contact === "object" && input.contact ? input.contact as Record<string, unknown> : input;
  const result = await upsertContactRecord({
    contact: withContactIdFromRequest(request, contact),
    requireExisting: true,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getWriteErrorStatus(result.reason) });
  }

  return NextResponse.json({ contact: result.data, persisted: true });
}

export async function DELETE(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
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
