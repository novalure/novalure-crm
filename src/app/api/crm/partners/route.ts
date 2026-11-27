import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, executeCrmCommand, withCrmRead } from "@/lib/crm-command";
import { createCrmPartnerRequest, linkCrmPartnerReservation, loadCrmPartnerWorkspace, saveCrmPartnerGrant, withdrawCrmPartnerRequest } from "@/lib/db/crm-partner-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { const project = new URL(request.url).searchParams.get("projectId"), data = await withCrmRead(auth.session, (tx, session) => loadCrmPartnerWorkspace(tx, session, project ? assertCrmUuid(project) : null)); return Response.json({ data, persisted: true }, { headers }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request);
    if (Object.keys(body).some((key) => !["action", "projectId", "partnerId", "kind", "targetId", "label", "expiresAt", "reviewed", "status", "expectedRevision", "grantId", "unitId", "leadGrantId", "reference", "requestId", "leadId", "unitVersion"].includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Partnerfelder prüfen");
    if (body.action === "request") { const data = await withCrmRead(auth.session, (tx, session) => createCrmPartnerRequest(tx, session, body, assertCrmUuid(request.headers.get("idempotency-key")))); return Response.json({ data, persisted: true, bindingReservation: false }, { headers }); }
    if (body.action === "withdraw") { const data = await withCrmRead(auth.session, (tx, session) => withdrawCrmPartnerRequest(tx, session, assertCrmUuid(body.requestId), Number(body.expectedRevision))); return Response.json({ data, persisted: true }, { headers }); }
    const metadata = crmRequestMetadata(request, body);
    if (body.action === "link_reservation") { const result = await linkCrmPartnerReservation(auth.session, body, metadata); return Response.json({ data: result.data, persisted: true, replayed: result.replayed, bindingReservation: false }, { headers }); }
    if (body.action === "grant") {
      const result = await executeCrmCommand(auth.session, { ...metadata, operation: "partner.save_grant", projectId: assertCrmUuid(body.projectId), capability: "workspace:operate", payload: body }, (tx, context) => saveCrmPartnerGrant(tx, context.session, body));
      return Response.json({ data: result.data, persisted: true, replayed: result.replayed }, { headers });
    }
    throw new CrmCommandError("INVALID_ACTION", "Partneraktion prüfen");
  } catch (error) { return crmCommandErrorResponse(error); }
}
