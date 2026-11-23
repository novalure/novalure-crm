import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { reconcileWebsiteSalesConversationCommand } from "@/lib/db/website-sales-conversation-repositories";
import { conversationCommandBody, conversationError } from "@/lib/website-sales-conversation-http";

export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await conversationCommandBody(request), result = await reconcileWebsiteSalesConversationCommand(auth.session, input);
    return Response.json({ ...result, contractVersion: "website-sales-conversation-reconcile-v1", correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationError(error); }
}
