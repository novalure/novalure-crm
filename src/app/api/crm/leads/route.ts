import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { upsertLeadRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getLeadWriteStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (
    reason.includes("required") ||
    reason.includes("Invalid") ||
    reason.includes("too long") ||
    reason.includes("cannot be in the past")
  ) return 400;
  return 503;
}

function getLeadIdFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("id") ?? url.searchParams.get("leadId") ?? "";
}

function getIdempotencyKeyFromRequest(request: Request): { ok: true; value?: string } | { ok: false; reason: string } {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) return { ok: true };
  if (value.length > 180) return { ok: false, reason: "Idempotency-Key is too long" };
  if (/[\r\n]/.test(value)) return { ok: false, reason: "Invalid Idempotency-Key" };
  return { ok: true, value };
}

function withLeadIdFromRequest(request: Request, lead: Record<string, unknown>) {
  if (typeof lead.id === "string" && lead.id.trim().length > 0) return lead;
  const id = getLeadIdFromRequest(request);
  return id ? { ...lead, id } : lead;
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const lead = typeof input.lead === "object" && input.lead ? input.lead as Record<string, unknown> : input;
  const idempotencyKey = getIdempotencyKeyFromRequest(request);
  if (!idempotencyKey.ok) {
    return NextResponse.json({ error: idempotencyKey.reason }, { status: getLeadWriteStatus(idempotencyKey.reason) });
  }

  const result = await upsertLeadRecord({ idempotencyKey: idempotencyKey.value, lead, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getLeadWriteStatus(result.reason) });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const lead = typeof input.lead === "object" && input.lead ? input.lead as Record<string, unknown> : input;
  const result = await upsertLeadRecord({
    lead: withLeadIdFromRequest(request, lead),
    requireExisting: true,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getLeadWriteStatus(result.reason) });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}
