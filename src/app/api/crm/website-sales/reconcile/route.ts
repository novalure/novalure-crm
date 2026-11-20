import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { reconcileWebsiteSalesIrelandCommand, type WebsiteSalesIrelandCommand } from "@/lib/db/website-sales-ireland-repositories";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

/** Exact original command receipt lookup. No business effect handler is invoked. */
export async function POST(request: Request) {
  let correlationId: string | undefined;
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
    if (!auth.ok) return auth.response;
    const body = await readKnowledgeJson(request, ["contractVersion", "operation", "projectId", "companyId", "locationId", "locationVersion", "expectedVersion", "payload", "idempotencyKey", "correlationId"], 131072);
    const metadata = crmRequestMetadata(request, body); correlationId = metadata.correlationId;
    if (body.idempotencyKey !== metadata.idempotencyKey || body.correlationId !== metadata.correlationId) throw new CrmCommandError("METADATA_MISMATCH", "Original command metadata required");
    const result = await reconcileWebsiteSalesIrelandCommand(auth.session, body as WebsiteSalesIrelandCommand);
    return Response.json({ ...result, contractVersion: "website-sales-reconcile-v1", correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof KnowledgeCenterError) return Response.json({ code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    return crmCommandErrorResponse(error, correlationId);
  }
}
