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

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const lead = typeof input.lead === "object" && input.lead ? input.lead as Record<string, unknown> : input;
  const result = await upsertLeadRecord({ lead, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getLeadWriteStatus(result.reason) });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  return POST(request);
}
