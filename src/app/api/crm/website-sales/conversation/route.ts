import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { executeWebsiteSalesConversationCommand, readWebsiteSalesConversation } from "@/lib/db/website-sales-conversation-repositories";
import { conversationCommandBody, conversationError } from "@/lib/website-sales-conversation-http";
import { websiteSalesConversationContract } from "@/lib/website-sales-conversation-types";

export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    for (const field of params.keys()) if (!["workspaceId", "projectId", "companyId", "locationId"].includes(field) || params.getAll(field).length !== 1) throw new CrmCommandError("INVALID_QUERY", "Exact conversation scope required");
    const scope = { projectId: assertCrmUuid(params.get("projectId")), companyId: assertCrmUuid(params.get("companyId")), locationId: assertCrmUuid(params.get("locationId")) };
    return Response.json(await readWebsiteSalesConversation(auth.session, scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationError(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await conversationCommandBody(request), result = await executeWebsiteSalesConversationCommand(auth.session, input);
    return Response.json({ ...result, contractVersion: websiteSalesConversationContract, persisted: true, correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationError(error); }
}
