import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { changeDealStageRecord } from "@/lib/db/crm-write-repositories";

type RouteContext = {
  params: Promise<{ dealId: string }>;
};

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;
  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const result = await changeDealStageRecord({
    dealId,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    reasonCategory: input.reasonCategory,
    reasonDetail: typeof input.reasonDetail === "string" ? input.reasonDetail : undefined,
    session: auth.session,
    toStage: input.toStage,
  });

  if (!result.persisted) {
    const normalizedReason = result.reason.toLowerCase();
    const status = normalizedReason.includes("permission")
      ? 403
      : normalizedReason.includes("not found")
        ? 404
        : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json({
    deal: result.data.deal,
    history: result.data.history,
    persisted: true,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return POST(request, context);
}
