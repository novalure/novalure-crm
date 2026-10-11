import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { exposeUuid, PropertyExposeError } from "@/lib/db/property-expose-repositories";
import { readPropertyExposePdf } from "@/lib/property-expose-service";
import { safeMediaContentDisposition } from "@/lib/media-security";
import { withCrmRead } from "@/lib/crm-command";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "cache-control": "private, no-store", Vary: "Cookie", "content-security-policy": "sandbox; default-src 'none'",
  "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const url = new URL(request.url), { documentId } = await context.params;
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  if (!exposeUuid(documentId) || url.hash || [...url.searchParams.keys()].some(k => !["workspaceId", "propertyId", "download"].includes(k)) ||
      ["workspaceId", "propertyId"].some(k => url.searchParams.getAll(k).length !== 1 || !exposeUuid(url.searchParams.get(k))) ||
      url.searchParams.getAll("download").length > 1 || url.searchParams.has("download") && url.searchParams.get("download") !== "1") {
    return Response.json({ error: "Invalid Exposé scope.", code: "EXPOSE_INVALID_SCOPE" }, { status: 400, headers });
  }
  try {
    const result = await withCrmRead(auth.session, (_tx, scopedSession) =>
      readPropertyExposePdf(scopedSession, url.searchParams.get("propertyId")!, documentId));
    const disposition = safeMediaContentDisposition(result.version.fileName, "application/pdf");
    return new Response(Buffer.from(result.bytes), { headers: { ...headers, "content-type": "application/pdf",
      "content-length": String(result.bytes.byteLength), "content-disposition": url.searchParams.has("download") ? disposition : disposition.replace(/^attachment;/, "inline;") } });
  } catch (error) {
    console.error(JSON.stringify({ event: "property_expose_pdf_failure", code: error instanceof PropertyExposeError ? error.code : "EXPOSE_READ_FAILED" }));
    return Response.json({ error: error instanceof PropertyExposeError ? error.message : "Exposé file could not be read.",
      code: error instanceof PropertyExposeError ? error.code : "EXPOSE_READ_FAILED" }, { status: error instanceof PropertyExposeError ? error.status : 503, headers });
  }
}
