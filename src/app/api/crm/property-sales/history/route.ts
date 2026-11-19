import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse } from "@/lib/crm-command";
import { loadPropertySalesHistory } from "@/lib/db/property-sales-history-repository";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) {
      Object.entries(headers).forEach(([key, value]) => auth.response.headers.set(key, value));
      return auth.response;
    }
    const query = new URL(request.url).searchParams;
    if (["workspaceId", "projectId", "unitId", "reservationId", "cursor"].some(key => query.getAll(key).length > 1)) {
      throw new CrmCommandError("VALIDATION_ERROR", "History selectors must be unambiguous", 400);
    }
    const data = await loadPropertySalesHistory(auth.session, {
      projectId: query.get("projectId") ?? "", unitId: query.get("unitId") ?? "",
      reservationId: query.has("reservationId") ? query.get("reservationId") : null,
      cursor: query.has("cursor") ? query.get("cursor") ?? "" : undefined,
    });
    return Response.json({ data, source: "database" }, { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }
}
