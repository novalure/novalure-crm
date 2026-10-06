import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { executeEvelynContractCommand, getEvelynContractAction, type EvelynContractCommand } from "@/lib/db/evelyn-contract-repositories";
import {
  executeEvelynContractV2Command,
  getEvelynContractActionV2,
  type EvelynContractV2Command,
} from "@/lib/db/evelyn-contract-v2-repositories";
import { CRM_VERCEL_PROJECT_ID, EvelynApprovalError } from "@/lib/evelyn-approval-client";
import { readBoundedCrmJson } from "@/lib/crm-request-body";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
function previewEnabled() {
  const vercelPreview = process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview"
    && (!process.env.VERCEL_TARGET_ENV || process.env.VERCEL_TARGET_ENV === "preview")
    && process.env.VERCEL_PROJECT_ID === CRM_VERCEL_PROJECT_ID;
  const isolatedLocalTest = process.env.NODE_ENV === "test" && process.env.CRM_LOCAL_TEST_DATABASE === "1"
    && process.env.VERCEL === undefined && process.env.VERCEL_ENV === undefined && process.env.VERCEL_URL === undefined;
  return vercelPreview || isolatedLocalTest;
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
    const query = new URL(request.url).searchParams;
    const contractVersion = query.get("approvalContractVersion") ?? "v1";
    if (!['v1', 'v2'].includes(contractVersion)) throw new CrmCommandError("EVELYN_CONTRACT_VERSION_DENIED", "Contract version not supported");
    const actionId = query.get("actionId") ?? "";
    const data = contractVersion === "v2"
      ? await getEvelynContractActionV2(auth.session, actionId)
      : await getEvelynContractAction(auth.session, actionId);
    return Response.json(data, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  if (!previewEnabled()) return unavailable();
  let correlationId: string | undefined;
  try {
    const raw = await readBoundedCrmJson(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    const input = raw as Record<string, unknown>;
    const operation = input.operation;
    if (typeof operation !== "string" || !["create", "revise", "request", "verify", "execute"].includes(operation)) throw new CrmCommandError("EVELYN_OPERATION_DENIED", "Operation not supported");
    const approvalContractVersion = input.approvalContractVersion ?? "v1";
    if (approvalContractVersion !== "v1" && approvalContractVersion !== "v2") throw new CrmCommandError("EVELYN_CONTRACT_VERSION_DENIED", "Contract version not supported");
    if (approvalContractVersion === "v1" && (operation === "create" || operation === "revise")) {
      throw new CrmCommandError("EVELYN_V2_REQUIRED", "New and materially changed contract actions require approval contract V2", 409);
    }
    const fields = ["operation", "projectId", "idempotencyKey", "correlationId"];
    if (input.approvalContractVersion !== undefined) fields.push("approvalContractVersion");
    if (operation === "create") fields.push("offerId", "expectedOfferVersion");
    else {
      fields.push("actionId", "expectedVersion");
      if (operation === "revise" && approvalContractVersion === "v1") fields.push("contractNetCents");
      if (operation === "verify" || operation === "execute") fields.push("approvalReference");
    }
    if (approvalContractVersion === "v2" && (operation === "create" || operation === "revise")) fields.push("policySelection");
    assertCrmFields(input, fields);
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = approvalContractVersion === "v2"
      ? await executeEvelynContractV2Command(auth.session, { ...input, ...metadata, approvalContractVersion: "v2" } as EvelynContractV2Command)
      : await executeEvelynContractCommand(auth.session, { ...input, ...metadata } as EvelynContractCommand);
    return Response.json({ ...result, correlationId, synthetic: true, externalEffect: false }, { headers: noStore });
  } catch (error) { return failure(error, correlationId); }
}
