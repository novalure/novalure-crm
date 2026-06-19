import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { upsertDealRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getDealWriteStatus(reason: string) {
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
    reason.includes("greater than zero") ||
    reason.includes("implausibly") ||
    reason.includes("not configured")
  ) return 400;
  return 503;
}

function getDealIdFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("id") ?? url.searchParams.get("dealId") ?? "";
}

function withDealIdFromRequest(request: Request, deal: Record<string, unknown>) {
  if (typeof deal.id === "string" && deal.id.trim().length > 0) return deal;
  const id = getDealIdFromRequest(request);
  return id ? { ...deal, id } : deal;
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const deal = typeof input.deal === "object" && input.deal ? input.deal as Record<string, unknown> : input;
  const result = await upsertDealRecord({
    deal,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    reasonCategory: input.reasonCategory,
    reasonDetail: typeof input.reasonDetail === "string" ? input.reasonDetail : undefined,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getDealWriteStatus(result.reason) });
  }

  return NextResponse.json({ deal: result.data, persisted: true });
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const deal = typeof input.deal === "object" && input.deal ? input.deal as Record<string, unknown> : input;
  const result = await upsertDealRecord({
    deal: withDealIdFromRequest(request, deal),
    reason: typeof input.reason === "string" ? input.reason : undefined,
    reasonCategory: input.reasonCategory,
    reasonDetail: typeof input.reasonDetail === "string" ? input.reasonDetail : undefined,
    requireExisting: true,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getDealWriteStatus(result.reason) });
  }

  return NextResponse.json({ deal: result.data, persisted: true });
}
