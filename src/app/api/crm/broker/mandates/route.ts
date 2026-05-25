import { NextResponse } from "next/server";
import { requirePermission, requirePermissionAndProductCapability } from "@/lib/auth/session";
import { upsertBrokerMandate } from "@/lib/db/broker-entity-repositories";
import { loadBrokerMandates } from "@/lib/db/crm-loaders";

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

  const mandates = await loadBrokerMandates(auth.session.workspaceId);
  return NextResponse.json({ mandates, source: "database" });
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "pipeline:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const mandate = typeof input.mandate === "object" && input.mandate
    ? input.mandate as Record<string, unknown>
    : input;
  const result = await upsertBrokerMandate({ mandate, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ mandate: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  return POST(request);
}
