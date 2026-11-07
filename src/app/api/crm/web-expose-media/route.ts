import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, executeCrmCommand, withCrmRead, CrmCommandError } from "@/lib/crm-command";
import { readBoundedJsonObject } from "@/lib/external-api-response";
import { webExposeResourceKinds } from "@/lib/web-expose-media";
import { archiveWebExposeResource, getWebExposeResourceFile, loadWebExposeMedia, saveWebExposeResource, uploadWebExposeResource, webExposeMediaHeaders } from "@/lib/web-expose-media-repository";
import { readWebExposeUploadForm } from "@/lib/web-expose-media-validation";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url), propertyId = assertCrmUuid(url.searchParams.get("propertyId"), "propertyId");
    if (url.searchParams.get("file") === "1") {
      const { asset, content } = await withCrmRead(auth.session, (tx, session) => getWebExposeResourceFile(tx, session, propertyId, assertCrmUuid(url.searchParams.get("resourceId"), "resourceId")));
      const inline = asset.mimeType.startsWith("image/") || asset.mimeType.startsWith("video/") || asset.mimeType === "application/pdf";
      return new Response(content.body instanceof Uint8Array ? new Uint8Array(content.body) : content.body, { headers: { ...webExposeMediaHeaders, "Content-Type": asset.mimeType, "Content-Length": String(content.sizeBytes), "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="resource-${asset.id}.${asset.mimeType === "application/pdf" ? "pdf" : asset.mimeType.split("/")[1]}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
    }
    const data = await withCrmRead(auth.session, (tx, session) => loadWebExposeMedia(tx, session, propertyId));
    return Response.json({ data, persisted: true }, { headers: webExposeMediaHeaders });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" }); if (!auth.ok) return auth.response;
  try {
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const propertyId = assertCrmUuid(new URL(request.url).searchParams.get("propertyId"), "propertyId"), metadata = crmRequestMetadata(request, {});
      let form: FormData; try { form = await readWebExposeUploadForm(request); } catch { throw new CrmCommandError("INVALID_UPLOAD", "Eine Datei mit maximal 4 MB hochladen."); }
      if ([...form.keys()].some((key) => !["file", "kind", "title"].includes(key)) || [...form.keys()].length !== 3) throw new CrmCommandError("INVALID_UPLOAD", "Uploadfelder prüfen");
      const file = form.get("file"), kind = form.get("kind"), title = form.get("title");
      if (!(file instanceof File) || typeof title !== "string" || title.length > 300 || !title.trim() || /[\u0000-\u001f]/.test(title) || typeof kind !== "string" || !(webExposeResourceKinds as readonly string[]).includes(kind) || kind === "external_link") throw new CrmCommandError("INVALID_UPLOAD", "Dateityp und Titel prüfen");
      let result;
      try { result = await uploadWebExposeResource(auth.session, { ...metadata, propertyId, kind: kind as Exclude<typeof webExposeResourceKinds[number], "external_link">, title, file }); }
      catch (error) { if (error instanceof CrmCommandError) throw error; if (error instanceof Error && /Datei|Bild|MP4|WebM|PDF|Videospur|Dateigröße/.test(error.message)) throw new CrmCommandError("INVALID_FILE", error.message); throw error; }
      return Response.json({ data: result.data, persisted: true, replayed: result.replayed }, { headers: webExposeMediaHeaders });
    }
    const body = await readBoundedJsonObject(request), propertyId = assertCrmUuid(body.propertyId, "propertyId"), metadata = crmRequestMetadata(request, body);
    if (Object.keys(body).some((key) => !["propertyId", "action", "resource", "resourceId", "expectedRevision", "reviewed"].includes(key))) throw new CrmCommandError("INVALID_INPUT", "Ressourcenfelder prüfen");
    const result = await executeCrmCommand(auth.session, { ...metadata, operation: `web_expose.resource_${String(body.action)}`, resourceId: propertyId, capability: "workspace:operate", payload: body }, async (tx, context) => {
      if (body.action === "save") return saveWebExposeResource(tx, context.session, propertyId, body.resource, { resourceId: body.resourceId ? assertCrmUuid(body.resourceId) : undefined, expectedRevision: Number(body.expectedRevision), reviewed: body.reviewed === true });
      if (body.action === "archive") return archiveWebExposeResource(tx, context.session, propertyId, assertCrmUuid(body.resourceId), Number(body.expectedRevision));
      throw new CrmCommandError("INVALID_ACTION", "Ressourcenaktion prüfen");
    });
    return Response.json({ data: result.data, persisted: true, replayed: result.replayed }, { headers: webExposeMediaHeaders });
  } catch (error) { return crmCommandErrorResponse(error); }
}
