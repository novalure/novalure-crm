import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { executeEvelynContractCommand, getEvelynContractAction, type EvelynContractCommand } from "@/lib/db/evelyn-contract-repositories";
import { CRM_VERCEL_PROJECT_ID, EvelynApprovalError } from "@/lib/evelyn-approval-client";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
function previewEnabled() {
  return process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview"
    && (!process.env.VERCEL_TARGET_ENV || process.env.VERCEL_TARGET_ENV === "preview")
    && process.env.VERCEL_PROJECT_ID === CRM_VERCEL_PROJECT_ID;
}
function unavailable() { return Response.json({ code: "EVELYN_PREVIEW_ONLY" }, { status: 404, headers: noStore }); }
function failure(error: unknown, correlationId?: string) {
  if (error instanceof EvelynApprovalError) return Response.json({ code: "EVELYN_" + error.code, correlationId, executionAllowed: false }, { status: 409, headers: noStore });
  const response = crmCommandErrorResponse(error, correlationId);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  if (!previewEnabled()) return unavailable();
  try {
    const data = await getEvelynContractAction(auth.session, new URL(request.url).searchParams.get("actionId") ?? "");
    return Response.json(data, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  if (!previewEnabled()) return unavailable();
  let correlationId: string | undefined;
  try {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new CrmCommandError("JSON_REQUIRED", "JSON required", 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) throw new CrmCommandError("BODY_TOO_LARGE", "Body too large", 413);
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    const input = raw as Record<string, unknown>;
    const operation = input.operation;
    if (typeof operation !== "string" || !["create", "revise", "request", "verify", "execute"].includes(operation)) throw new CrmCommandError("EVELYN_OPERATION_DENIED", "Operation not supported");
    const fields = ["operation", "projectId", "idempotencyKey", "correlationId"];
    if (operation === "create") fields.push("offerId", "expectedOfferVersion");
    else {
      fields.push("actionId", "expectedVersion");
      if (operation === "revise") fields.push("contractNetCents");
      if (operation === "verify" || operation === "execute") fields.push("approvalReference");
    }
    assertCrmFields(input, fields);
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = await executeEvelynContractCommand(auth.session, { ...input, ...metadata } as EvelynContractCommand);
    return Response.json({ ...result, correlationId, synthetic: true, externalEffect: false }, { headers: noStore });
  } catch (error) {
    return failure(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error, correlationId);
  }
}
