import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { exposeUuid, PropertyExposeError } from "@/lib/db/property-expose-repositories";
import { getPropertyExposeState, mutatePropertyExpose } from "@/lib/property-expose-service";
import { PROPERTY_EXPOSE_MAX_PDF_BYTES } from "@/lib/property-expose";
import { withCrmRead } from "@/lib/crm-command";

export const runtime = "nodejs";
export const maxDuration = 120;
const headers = { "cache-control": "private, no-store", Vary: "Cookie", "x-content-type-options": "nosniff" };
function validScope(request: Request, read: boolean) {
  const url = new URL(request.url), allowed = read ? ["workspaceId", "propertyId"] : ["workspaceId"];
  return !url.hash && [...url.searchParams.keys()].every(key => allowed.includes(key)) &&
    allowed.every(key => url.searchParams.getAll(key).length === 1 && exposeUuid(url.searchParams.get(key)));
}
function failure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "EXPOSE_FAILED";
  console.error(JSON.stringify({ event: "property_expose_failure", code: /^[A-Z_]{3,60}$/.test(code) ? code : "EXPOSE_FAILED" }));
  if (error instanceof PropertyExposeError) return Response.json({ persisted: false, error: error.message, code: error.code }, { status: error.status, headers });
  // Renderer/validator use a dedicated safe error class; native errors and SQL never reach clients.
  if (error instanceof Error && error.name === "PropertyExposePdfError") {
    return Response.json({ persisted: false, error: error.message, code }, { status: code.includes("TOO_LARGE") ? 413 : 400, headers });
  }
  return Response.json({ persisted: false, error: "Exposé operation could not be confirmed. Reload before trying again.", code: "EXPOSE_FAILED" }, { status: 503, headers });
}
async function limitedBody(request: Request, max: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new PropertyExposeError("EXPOSE_REQUEST_TOO_LARGE", 413, "Request exceeds the allowed size.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) throw new PropertyExposeError("EXPOSE_REQUEST_TOO_LARGE", 413, "Request exceeds the allowed size.");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  if (!validScope(request, true)) return Response.json({ persisted: false, error: "Invalid Exposé scope.", code: "EXPOSE_INVALID_SCOPE" }, { status: 400, headers });
  try {
    const data = await withCrmRead(auth.session, (_tx, scopedSession) =>
      getPropertyExposeState(scopedSession, new URL(request.url).searchParams.get("propertyId")!));
    return Response.json({ persisted: true, data }, { headers });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  if (!validScope(request, false)) return Response.json({ persisted: false, error: "Invalid Exposé scope.", code: "EXPOSE_INVALID_SCOPE" }, { status: 400, headers });
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    let input: Record<string, unknown>, file: File | undefined;
    if (contentType.startsWith("multipart/form-data")) {
      const bytes = await limitedBody(request, PROPERTY_EXPOSE_MAX_PDF_BYTES + 65536);
      const form = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type")! } }).formData();
      const keys = ["operation", "propertyId", "expectedRevision", "file"];
      if ([...form.keys()].some(k => !keys.includes(k)) || keys.some(k => form.getAll(k).length !== 1) || form.get("operation") !== "upload" || !(form.get("file") instanceof File)) {
        throw new PropertyExposeError("EXPOSE_REQUEST_INVALID", 400, "Invalid PDF upload form.");
      }
      file = form.get("file") as File;
      input = { operation: "upload", propertyId: form.get("propertyId"), expectedRevision: form.get("expectedRevision") };
    } else if (contentType.startsWith("application/json")) {
      const raw = await limitedBody(request, 65536);
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PropertyExposeError("EXPOSE_REQUEST_INVALID", 400, "Invalid Exposé request.");
      input = parsed;
      const allowed: Record<string, string[]> = { generate: ["operation", "propertyId", "expectedRevision", "options", "confirmed"],
        activate: ["operation", "propertyId", "expectedRevision", "documentId", "confirmed"],
        deactivate: ["operation", "propertyId", "expectedRevision", "confirmed"], preferences: ["operation", "propertyId", "expectedRevision", "preferredSource"] };
      const keys = allowed[String(input.operation)];
      if (!keys || Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(input, k))) {
        throw new PropertyExposeError("EXPOSE_REQUEST_INVALID", 400, "Invalid Exposé operation fields.");
      }
    } else throw new PropertyExposeError("EXPOSE_REQUEST_INVALID", 415, "JSON or PDF multipart input is required.");
    return Response.json(await withCrmRead(auth.session, (_tx, scopedSession) =>
      mutatePropertyExpose(scopedSession, input, file)), { headers });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError && /formdata|multipart/i.test(error.message)) {
      return Response.json({ persisted: false, error: "Invalid Exposé request.", code: "EXPOSE_REQUEST_INVALID" }, { status: 400, headers });
    }
    return failure(error);
  }
}
