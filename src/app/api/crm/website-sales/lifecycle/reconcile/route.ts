import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { reconcileWebsiteSalesLifecycleCommand } from "@/lib/db/website-sales-lifecycle-repositories";
import { lifecycleCommandBody, lifecycleError } from "@/lib/website-sales-lifecycle-http";
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await lifecycleCommandBody(request), result = await reconcileWebsiteSalesLifecycleCommand(auth.session, input);
    return Response.json({ ...result, contractVersion: "website-sales-lifecycle-reconcile-v1", correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return lifecycleError(error); }
}
