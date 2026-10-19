import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { readCalendarConnectionStatuses } from "@/lib/db/crm-operational-readers";
import { operationalReadErrorResponse, operationalReadJson, parseOperationalReadQuery } from "@/lib/operational-read-http";

export async function GET(request: Request) {
  try {
    parseOperationalReadQuery(request, "calendar");
    const auth = await resolveWorkspaceScopedSession(request, { permission: "calendar:sync", capability: "calendar:manage" });
    if (!auth.ok) {
      auth.response.headers.set("cache-control", "private, no-store");
      auth.response.headers.set("x-content-type-options", "nosniff");
      auth.response.headers.set("referrer-policy", "no-referrer");
      return auth.response;
    }
    return operationalReadJson(await readCalendarConnectionStatuses(auth.session));
  } catch (error) {
    return operationalReadErrorResponse(error);
  }
}
