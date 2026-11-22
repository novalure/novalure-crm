import { ZodError } from "zod";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { matchWebsiteSalesDiscovery, registerWebsiteSalesDiscovery } from "@/lib/db/website-sales-discovery-repositories";
import { websiteSalesDiscoveryContract } from "@/lib/website-sales-discovery";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const body = await readKnowledgeJson(request, ["contractVersion", "operation", "projectId", "candidate", "expectedMatchDigest", "decision", "idempotencyKey", "correlationId"], 65536);
    if (body.operation === "match") return Response.json(await matchWebsiteSalesDiscovery(auth.session, body), { headers });
    const metadata = crmRequestMetadata(request, body);
    if (body.idempotencyKey !== metadata.idempotencyKey || body.correlationId !== metadata.correlationId) throw new CrmCommandError("METADATA_MISMATCH", "Exact original metadata required");
    const result = await registerWebsiteSalesDiscovery(auth.session, body);
    return Response.json({ ...result, contractVersion: websiteSalesDiscoveryContract, workspaceId: auth.session.workspaceId,
      projectId: body.projectId, correlationId: body.correlationId, persisted: body.operation === "register" || Reflect.get(result, "status") === "COMMITTED" }, { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError("DISCOVERY_INVALID_REQUEST", "Discovery facts require valid public sources", 400) : error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
