import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, crmCommandErrorResponse, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { loadCrmNotifications, markCrmNotificationsRead, prepareCrmNotificationDigest, saveCrmNotificationPreferences } from "@/lib/db/crm-notifications-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
function scope(request: Request) { const value = new URL(request.url).searchParams.get("projectId"); return value ? assertCrmUuid(value, "projectId") : null; }
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { const data = await withCrmRead(auth.session, (tx, session) => loadCrmNotifications(tx, session, scope(request))); return Response.json({ data, persisted: true }, { headers }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  // Personal preferences/read receipts do not grant business write permission.
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request), projectId = scope(request);
    if (Object.keys(body).some((key) => !["action", "preferences", "expectedRevision", "keys"].includes(key))) throw new CrmCommandError("INVALID_INPUT", "Persönliche Hinweisdaten ungültig");
    const data = await withCrmRead(auth.session, async (tx, session) => {
      if (projectId) await assertProjectGrant(tx, session, projectId, false);
      if (body.action === "preferences") return saveCrmNotificationPreferences(tx, session, body.preferences, Number(body.expectedRevision), assertCrmUuid(request.headers.get("idempotency-key"), "Idempotency-Key"));
      if (body.action === "read") return markCrmNotificationsRead(tx, session, body.keys, projectId);
      if (body.action === "digest") return prepareCrmNotificationDigest(tx, session, projectId, assertCrmUuid(request.headers.get("idempotency-key"), "Idempotency-Key"));
      throw new CrmCommandError("INVALID_ACTION", "Hinweisaktion ungültig");
    });
    return Response.json({ data, persisted: true, sent: false }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
