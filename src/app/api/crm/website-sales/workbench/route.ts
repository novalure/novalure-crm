import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse } from "@/lib/crm-command";
import { parseWebsiteSalesWorkbenchQuery, readWebsiteSalesWorkbench } from "@/lib/db/website-sales-workbench-repository";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    // Existing verified membership, MFA and mandatory cross-workspace security audit remain intact.
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const query = parseWebsiteSalesWorkbenchQuery(new URL(request.url).searchParams);
    return Response.json(await readWebsiteSalesWorkbench(auth.session, query), { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
