import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { executeWebsiteSalesLifecycleCommand, readWebsiteSalesLifecycle } from "@/lib/db/website-sales-lifecycle-repositories";
import { lifecycleCommandBody, lifecycleError } from "@/lib/website-sales-lifecycle-http";
import { websiteSalesLifecycleContract } from "@/lib/website-sales-lifecycle-types";
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    for (const field of params.keys()) if (!["workspaceId", "projectId", "companyId", "locationId"].includes(field) || params.getAll(field).length !== 1) throw new CrmCommandError("INVALID_QUERY", "Exact lifecycle scope required");
    const scope = { projectId: assertCrmUuid(params.get("projectId")), companyId: assertCrmUuid(params.get("companyId")), locationId: assertCrmUuid(params.get("locationId")) };
    return Response.json(await readWebsiteSalesLifecycle(auth.session, scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return lifecycleError(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await lifecycleCommandBody(request), result = await executeWebsiteSalesLifecycleCommand(auth.session, input);
    return Response.json({ ...result, contractVersion: websiteSalesLifecycleContract, persisted: true, correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return lifecycleError(error); }
}
