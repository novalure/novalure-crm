import { ZodError } from "zod";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "./crm-command";
import { KnowledgeCenterError } from "./knowledge-center/policy";
import { readKnowledgeJson } from "./knowledge-center/http";
import { WebsiteStudioError } from "./website-sales-studio";
import type { WebsiteSalesLifecycleCommand } from "./website-sales-lifecycle-types";
export async function lifecycleCommandBody(request: Request) {
  const body = await readKnowledgeJson(request, ["contractVersion", "operation", "projectId", "companyId", "locationId", "expectedVersion", "idempotencyKey", "correlationId", "payload"], 131072);
  const metadata = crmRequestMetadata(request, body);
  if (body.idempotencyKey !== metadata.idempotencyKey || body.correlationId !== metadata.correlationId) throw new CrmCommandError("METADATA_MISMATCH", "Exact original metadata required");
  return body as WebsiteSalesLifecycleCommand;
}
export function lifecycleError(error: unknown) {
  if (error instanceof KnowledgeCenterError) return Response.json({ code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  return crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError("INVALID_LIFECYCLE_PAYLOAD", "Invalid lifecycle payload", 400)
    : error instanceof WebsiteStudioError ? new CrmCommandError(error.code, error.code, 409) : error);
}
