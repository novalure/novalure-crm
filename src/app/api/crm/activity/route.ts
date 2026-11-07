import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { CrmActivityValidationError, parseCrmActivityInput } from "@/lib/crm-activity";
import { readCrmActivity, recordCrmActivity } from "@/lib/crm-activity-repository";

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function failure(error: unknown) {
  const response = crmCommandErrorResponse(error instanceof CrmActivityValidationError ? new CrmCommandError("INVALID_ACTIVITY", error.message) : error);
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const query = new URL(request.url).searchParams;
    return Response.json(await readCrmActivity(auth.session, { contactId: query.get("contactId") || undefined, leadId: query.get("leadId") || undefined, projectId: query.get("projectId") || undefined, cursor: query.get("cursor") || undefined }), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" });
    if (!auth.ok) return auth.response;
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) throw new CrmCommandError("INVALID_REQUEST", "JSON ist erforderlich.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 16384) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Die Aktivität ist zu lang.", 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new CrmCommandError("INVALID_JSON", "Die Anfrage enthält kein gültiges JSON."); }
    const input = parseCrmActivityInput(body), metadata = crmRequestMetadata(request, body as Record<string, unknown>);
    const result = await recordCrmActivity(auth.session, input, metadata);
    return Response.json({ ...result.data, replayed: result.replayed, auditReference: result.auditReference, commandId: result.commandId }, { headers });
  } catch (error) { return failure(error); }
}
