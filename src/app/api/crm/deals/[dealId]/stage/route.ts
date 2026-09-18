import { withCrmSalesWrite } from "@/lib/crm-sales-http";
import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
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

async function postHandler(request: Request, session: AppSession, context: RouteContext) {
  const auth = { session };

  const { dealId } = await context.params;
  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const result = await changeDealStageRecord({
    expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
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

async function patchHandler(request: Request, session: AppSession, context: RouteContext) {
  return postHandler(request, session, context);
}

export const POST = withCrmSalesWrite(postHandler);
export const PATCH = withCrmSalesWrite(patchHandler);
