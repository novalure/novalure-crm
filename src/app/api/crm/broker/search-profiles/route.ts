import { NextResponse } from "next/server";
import { requirePermission, requirePermissionAndProductCapability } from "@/lib/auth/session";
import { upsertBuyerSearchProfile } from "@/lib/db/broker-entity-repositories";
import { loadBuyerSearchProfiles } from "@/lib/db/crm-loaders";

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

  const profiles = await loadBuyerSearchProfiles(auth.session.workspaceId);
  return NextResponse.json({ profiles, source: "database" });
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "pipeline:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const profile = typeof input.profile === "object" && input.profile
    ? input.profile as Record<string, unknown>
    : input;
  const result = await upsertBuyerSearchProfile({ profile, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ persisted: true, profile: result.data });
}

export async function PATCH(request: Request) {
  return POST(request);
}
