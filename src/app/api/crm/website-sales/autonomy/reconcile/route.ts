import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { reconcileSalesOperationsCommand } from "@/lib/db/website-sales-operations-repositories";
import { salesOperationsBody, salesOperationsError } from "@/lib/website-sales-operations-http";
import { compactWebsiteSalesOperationsReceipt } from "@/lib/website-sales-operations-receipt";
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
    const input = await salesOperationsBody(request), result = await reconcileSalesOperationsCommand(auth.session, input);
    return Response.json({ ...(result.status === "COMMITTED" ? compactWebsiteSalesOperationsReceipt(result, true) : result), contractVersion: "website-sales-operations-reconcile-v1", correlationId: input.correlationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return salesOperationsError(error); }
}
