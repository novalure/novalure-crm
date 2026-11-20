import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { executeSalesOperationsCommand, readSalesOperations } from "@/lib/db/website-sales-operations-repositories";
import { salesOperationsBody, salesOperationsError } from "@/lib/website-sales-operations-http";
import { websiteSalesOperationsContract } from "@/lib/website-sales-operations-types";
import { compactWebsiteSalesOperationsReceipt } from "@/lib/website-sales-operations-receipt";
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    for (const field of params.keys()) if (!["workspaceId", "projectId", "companyId", "locationId"].includes(field) || params.getAll(field).length !== 1) throw new CrmCommandError("INVALID_QUERY", "Exact lifecycle scope required");
    const scope = { projectId: assertCrmUuid(params.get("projectId")), companyId: assertCrmUuid(params.get("companyId")), locationId: assertCrmUuid(params.get("locationId")) };
    return Response.json(await readSalesOperations(auth.session, scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return salesOperationsError(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await salesOperationsBody(request), result = await executeSalesOperationsCommand(auth.session, input);
    return Response.json({ ...compactWebsiteSalesOperationsReceipt(result), contractVersion: websiteSalesOperationsContract, persisted: true, correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return salesOperationsError(error); }
}
