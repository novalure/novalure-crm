import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse } from "@/lib/crm-command";
import { getStoredFunnel, saveStoredFunnel, restoreStoredFunnelVersion } from "@/lib/funnel-store";
import { runFunnelPreflight } from "@/lib/funnel-publication";
import { readFunnelJson } from "@/lib/funnel-http";
import type { FunnelBlueprint } from "@/lib/funnel-schema";

type RouteContext = { params: Promise<{ funnelId: string }> };
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const { funnelId } = await context.params, saved = await getStoredFunnel(funnelId, auth.session);
    return saved ? Response.json({ ...saved, preflight: runFunnelPreflight(saved.blueprint) }, { headers }) : Response.json({ error: "Funnel nicht gefunden." }, { status: 404, headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function PUT(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "funnels:write", capability: "funnels:publish" });
  if (!auth.ok) return auth.response;
  try {
    const { funnelId } = await context.params, body = await readFunnelJson(request, 1100000);
    if (Object.keys(body).some(key => !["blueprint", "label", "restoreVersionId", "publishReviewed", "action"].includes(key))) throw new CrmCommandError("INVALID_REQUEST", "Unbekannte Funnelangaben.");
    if (typeof body.restoreVersionId === "string") {
      const restored = await restoreStoredFunnelVersion(funnelId, body.restoreVersionId, auth.session);
      return restored ? Response.json(restored, { headers }) : Response.json({ error: "Version nicht gefunden." }, { status: 404, headers });
    }
    if (body.action === "unpublish") {
      const current = await getStoredFunnel(funnelId, auth.session);
      if (!current) throw new CrmCommandError("NOT_FOUND", "Funnel nicht gefunden.", 404);
      return Response.json(await saveStoredFunnel({ ...current.blueprint, status: "entwurf" }, "Veröffentlichung beendet", auth.session, { unpublish: true }), { headers });
    }
    const blueprint = body.blueprint as FunnelBlueprint | undefined;
    if (!blueprint || blueprint.id !== funnelId || (body.label !== undefined && typeof body.label !== "string")) throw new CrmCommandError("INVALID_REQUEST", "Funnel-ID und Version prüfen.");
    if (blueprint.status === "aktiv" && body.publishReviewed !== true) throw new CrmCommandError("PUBLICATION_REVIEW", "Veröffentlichung und Datenschutz zuerst ausdrücklich prüfen.", 409);
    const saved = await saveStoredFunnel(blueprint, body.label as string | undefined, auth.session);
    return Response.json({ ...saved, preflight: runFunnelPreflight(saved.blueprint) }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
