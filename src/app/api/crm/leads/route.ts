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
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  return POST(request);
}
