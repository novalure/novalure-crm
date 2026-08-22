import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { upsertDealRecord } from "@/lib/db/crm-write-repositories";
import {
  qaBatchRuntimeErrorResponse,
  qaBatchSuccessHeaders,
  readQaBatchMutationHeader,
} from "@/lib/qa-batch-runtime";

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
    normalizedReason.includes("only be changed") ||
    normalizedReason.includes("historical")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (normalizedReason.includes("conflict")) return 409;
  if (
    reason.includes("required") ||
    reason.includes("Invalid") ||
    reason.includes("too long") ||
    reason.includes("greater than zero") ||
    reason.includes("implausibly") ||
    reason.includes("not configured") ||
    normalizedReason.includes("invalid") ||
    normalizedReason.includes("past")
  ) return 400;
  return 503;
}

function getDealIdFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("id") ?? url.searchParams.get("dealId") ?? "";
}

function getIdempotencyKeyFromRequest(request: Request): { ok: true; value?: string } | { ok: false; reason: string } {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) return { ok: true };
  if (value.length > 180) return { ok: false, reason: "Idempotency-Key is too long" };
  if (/[\r\n]/.test(value)) return { ok: false, reason: "Invalid Idempotency-Key" };
  return { ok: true, value };
}

function withDealIdFromRequest(request: Request, deal: Record<string, unknown>) {
  if (typeof deal.id === "string" && deal.id.trim().length > 0) return deal;
  const id = getDealIdFromRequest(request);
  return id ? { ...deal, id } : deal;
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  let qaBatchId: string | null;
  try {
    qaBatchId = readQaBatchMutationHeader(request, auth.session);
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? NextResponse.json({ error: "QA batch validation failed" }, { status: 503 });
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const deal = typeof input.deal === "object" && input.deal ? input.deal as Record<string, unknown> : input;
  const idempotencyKey = getIdempotencyKeyFromRequest(request);
  if (!idempotencyKey.ok) {
    return NextResponse.json({ error: idempotencyKey.reason }, { status: getDealWriteStatus(idempotencyKey.reason) });
  }

  let result;
  try {
    result = await upsertDealRecord({
      allowHistoricalCloseDate:
        input.historicalImport === true &&
        auth.session.productPermissions.includes("novalure:internal"),
      deal,
      idempotencyKey: idempotencyKey.value,
      qaBatchId: qaBatchId ?? undefined,
      reason: typeof input.reason === "string" ? input.reason : undefined,
      reasonCategory: input.reasonCategory,
      reasonDetail: typeof input.reasonDetail === "string" ? input.reasonDetail : undefined,
      session: auth.session,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? NextResponse.json({ error: "Deal could not be saved" }, { status: 503 });
  }

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getDealWriteStatus(result.reason) });
  }

  return NextResponse.json(
    { deal: result.data, persisted: true },
    { headers: qaBatchSuccessHeaders(qaBatchId, result.qaBatchRegistration) },
  );
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;

  let qaBatchId: string | null;
  try {
    qaBatchId = readQaBatchMutationHeader(request, auth.session);
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? NextResponse.json({ error: "QA batch validation failed" }, { status: 503 });
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const deal = typeof input.deal === "object" && input.deal ? input.deal as Record<string, unknown> : input;
  let result;
  try {
    result = await upsertDealRecord({
      allowHistoricalCloseDate:
        input.historicalImport === true &&
        auth.session.productPermissions.includes("novalure:internal"),
      deal: withDealIdFromRequest(request, deal),
      qaBatchId: qaBatchId ?? undefined,
      reason: typeof input.reason === "string" ? input.reason : undefined,
      reasonCategory: input.reasonCategory,
      reasonDetail: typeof input.reasonDetail === "string" ? input.reasonDetail : undefined,
      requireExisting: true,
      session: auth.session,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? NextResponse.json({ error: "Deal could not be saved" }, { status: 503 });
  }

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getDealWriteStatus(result.reason) });
  }

  return NextResponse.json(
    { deal: result.data, persisted: true },
    { headers: qaBatchSuccessHeaders(qaBatchId, result.qaBatchRegistration) },
  );
}
