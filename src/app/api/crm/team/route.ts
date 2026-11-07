import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse } from "@/lib/crm-command";
import { readCrmTeam } from "@/lib/db/crm-team-repository";

export async function GET(request: Request) {
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const projectId = new URL(request.url).searchParams.get("projectId") || undefined;
    return Response.json(await readCrmTeam(auth.session, projectId), { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }
}
