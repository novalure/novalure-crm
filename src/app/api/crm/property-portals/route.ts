import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, executeCrmCommand, withCrmRead, CrmCommandError } from "@/lib/crm-command";
import { downloadPropertyPortalExport, loadPropertyPortalState, preparePropertyPortalExport, previewPropertyPortal, propertyPortalHeaders, savePropertyPortalProfile } from "@/lib/db/property-portal-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url), propertyId = assertCrmUuid(url.searchParams.get("propertyId"), "propertyId");
    const jobId = url.searchParams.get("jobId");
    if (jobId) {
      const zip = await withCrmRead(auth.session, (tx, session) => downloadPropertyPortalExport(tx, session, propertyId, assertCrmUuid(jobId)));
      return new Response(new Uint8Array(zip), { headers: { ...propertyPortalHeaders, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="novalure-openimmo-${jobId}.zip"`, "X-Content-Type-Options": "nosniff" } });
    }
    const data = await withCrmRead(auth.session, (tx, session) => loadPropertyPortalState(tx, session, propertyId));
    return Response.json({ data, persisted: true }, { headers: propertyPortalHeaders });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request), propertyId = assertCrmUuid(body.propertyId, "propertyId");
    const action = body.action;
    if (action === "preview") {
      if (typeof body.portalName !== "string" || !["CHANGE", "DELETE"].includes(String(body.exportAction))) throw new CrmCommandError("INVALID_INPUT", "Portal und Exportaktion prüfen");
      const data = await withCrmRead(auth.session, (tx, session) => previewPropertyPortal(tx, session, propertyId, body.portalName as string, body.exportAction as "CHANGE" | "DELETE"));
      return Response.json({ data, preview: true, transmitted: false }, { headers: propertyPortalHeaders });
    }
    const metadata = crmRequestMetadata(request, body);
    const result = await executeCrmCommand(auth.session, { ...metadata, operation: "property_portal." + String(action), resourceId: propertyId, capability: "workspace:operate", payload: body }, async (tx, context) => {
      if (action === "save_profile") return savePropertyPortalProfile(tx, context.session, propertyId, body.profile, Number(body.expectedRevision));
      if (action === "prepare") {
        if (typeof body.portalName !== "string" || !["CHANGE", "DELETE"].includes(String(body.exportAction)) || typeof body.expectedSourceFingerprint !== "string" || typeof body.reviewed !== "boolean") throw new CrmCommandError("INVALID_INPUT", "Freigabe und Vorschau prüfen");
        return preparePropertyPortalExport(tx, context.session, { propertyId, portalName: body.portalName, action: body.exportAction as "CHANGE" | "DELETE", expectedSourceFingerprint: body.expectedSourceFingerprint, reviewed: body.reviewed, idempotencyKey: metadata.idempotencyKey });
      }
      if (action === "cancel") {
        const cancelled = await tx.queryOne(`update property_export_jobs set status='cancelled',updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and property_id=$3::uuid and metadata->>'kind'='openimmo_offline_export' and status='prepared' returning id,status`, [assertCrmUuid(body.jobId), context.workspaceId, propertyId]);
        if (!cancelled) throw new CrmCommandError("NOT_FOUND", "Vorbereitetes Paket nicht verfügbar", 404);
        return cancelled;
      }
      throw new CrmCommandError("INVALID_ACTION", "Aktion ungültig");
    });
    return Response.json({ data: result.data, persisted: true, replayed: result.replayed, transmitted: false }, { headers: propertyPortalHeaders });
  } catch (error) { return crmCommandErrorResponse(error); }
}
