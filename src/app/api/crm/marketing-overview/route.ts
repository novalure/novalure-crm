import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse } from "@/lib/crm-command";
import { readMarketingOverview } from "@/lib/db/marketing-overview-repository";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  try {
    const value = new URL(request.url).searchParams.get("projectId");
    return Response.json({ data: await readMarketingOverview(auth.session, value ? assertCrmUuid(value) : null) }, { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }
}
