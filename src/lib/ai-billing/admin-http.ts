import "server-only";

import { assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { readKnowledgeBytes, requireKnowledgeBotSession } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

type AiBillingAdminActionBase = {
  requestId: string;
  reference: string;
  idempotencyKey: string;
};
export type AiBillingAdminAction = AiBillingAdminActionBase & (
  { action: "fulfill"; paidThrough?: string } |
  { action: "close"; status: "fulfilled" | "cancelled" } |
  { action: "reconcile"; status: "succeeded" | "failed"; credits: number }
);

/** The workspace selector requests internal authority; active membership and MFA still decide it. */
export async function requireAiBillingAdminSession(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const [key] of params) {
    if (!(request.method === "GET" ? ["workspaceId", "targetWorkspaceId", "status"] : ["workspaceId"]).includes(key) || params.getAll(key).length !== 1) {
      throw new CrmCommandError("UNKNOWN_FIELD", "Unknown or duplicate billing administration selector");
    }
  }
  if (params.has("targetWorkspaceId")) assertCrmUuid(params.get("targetWorkspaceId"), "targetWorkspaceId");
  if (params.has("status") && !["pending", "fulfilled", "cancelled"].includes(params.get("status") ?? "")) {
    throw new CrmCommandError("VALIDATION_ERROR", "Choose a supported request status");
  }
  const auth = await requireKnowledgeBotSession(request, "crm:write");
  if (!auth.ok) { auth.response.headers.set("vary", "Cookie"); return auth; }
  const session = auth.session;
  if (!["owner", "admin"].includes(session.role) || !["platform_admin", "novalureAdmin"].includes(session.productRole) || session.workspaceOperatingModel !== "novalure_internal") {
    throw new CrmCommandError("AI_BILLING_ADMIN_FORBIDDEN", "Internal billing administration permission is required", 403);
  }
  return auth;
}

export async function readAiBillingAdminAction(request: Request): Promise<AiBillingAdminAction> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new CrmCommandError("JSON_REQUIRED", "Content-Type application/json is required", 415);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
    throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "A UUID v4 Idempotency-Key is required");
  }
  let body: unknown;
  try {
    const bytes = await readKnowledgeBytes(request, 8_192);
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new CrmCommandError("INVALID_JSON", "A valid JSON object is required"); }
  } catch (error) {
    if (error instanceof KnowledgeCenterError) throw new CrmCommandError(error.code, "Check the billing administration request", error.status);
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CrmCommandError("INVALID_JSON", "A JSON object is required");
  const input = body as Record<string, unknown>;
  const fields = input.action === "fulfill" ? ["action", "requestId", "reference", "paidThrough"]
    : input.action === "close" ? ["action", "requestId", "reference", "status"]
      : input.action === "reconcile" ? ["action", "requestId", "reference", "status", "credits"] : null;
  if (!fields) throw new CrmCommandError("VALIDATION_ERROR", "Choose a supported billing action");
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Unknown billing administration field");
  const requestId = assertCrmUuid(input.requestId, "requestId");
  if (typeof input.reference !== "string" || input.reference.trim().length < 3 || input.reference.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(input.reference)) {
    throw new CrmCommandError("VALIDATION_ERROR", "A documented confirmation reference is required");
  }
  const reference = input.reference.trim();
  if (input.action === "fulfill") {
    let paidThrough: string | undefined;
    if (input.paidThrough !== undefined) {
      if (typeof input.paidThrough !== "string" || input.paidThrough.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input.paidThrough) || !Number.isFinite(Date.parse(input.paidThrough))) {
        throw new CrmCommandError("VALIDATION_ERROR", "A valid paid-through timestamp with timezone is required");
      }
      paidThrough = new Date(input.paidThrough).toISOString();
    }
    return { action: "fulfill", requestId, reference, idempotencyKey, ...(paidThrough ? { paidThrough } : {}) };
  }
  if (input.action === "close") {
    if (input.status !== "fulfilled" && input.status !== "cancelled") throw new CrmCommandError("VALIDATION_ERROR", "Choose a supported request status");
    return { action: "close", requestId, reference, idempotencyKey, status: input.status };
  }
  if ((input.status !== "succeeded" && input.status !== "failed") || typeof input.credits !== "number" || !Number.isSafeInteger(input.credits) || input.credits < 0 || input.credits > 100_000 || (input.status === "failed" && input.credits !== 0)) {
    throw new CrmCommandError("VALIDATION_ERROR", "Check the verified usage and reconciliation result");
  }
  return { action: "reconcile", requestId, reference, idempotencyKey, status: input.status, credits: input.credits };
}
