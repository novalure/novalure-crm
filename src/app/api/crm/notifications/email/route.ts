import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { loadCrmNotificationEmail, retryCrmNotificationEmail, saveCrmNotificationEmail } from "@/lib/db/crm-notification-email-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { return Response.json({ data: await withCrmRead(auth.session, loadCrmNotificationEmail), persisted: true }, { headers }); } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const input = await readBoundedJsonObject(request), requestId = assertCrmUuid(request.headers.get("idempotency-key"));
    let data;
    if (input.action === "preferences") { assertCrmFields(input, ["action", "preferences", "expectedRevision"]); data = await withCrmRead(auth.session, (tx, session) => saveCrmNotificationEmail(tx, session, input.preferences, input.expectedRevision, requestId)); }
    else if (input.action === "retry") { assertCrmFields(input, ["action", "id", "expectedRevision"]); data = await withCrmRead(auth.session, (tx, session) => retryCrmNotificationEmail(tx, session, assertCrmUuid(input.id), input.expectedRevision)); }
    else throw new CrmCommandError("INVALID_ACTION", "Digest-Aktion prüfen");
    return Response.json({ data, persisted: true, sent: false }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
