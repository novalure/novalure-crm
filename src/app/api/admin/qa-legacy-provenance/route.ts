import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { runQaLegacyProvenance } from "@/lib/qa-legacy-provenance";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "cache-control": "private, no-store", "vary": "Cookie", "x-content-type-options": "nosniff" };

export async function POST(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    for (const [key] of params) if (key !== "workspaceId" || params.getAll(key).length !== 1) throw new CrmCommandError("INVALID_SELECTOR", "Only one authorized origin workspace selector is supported");
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
    if (!auth.ok) {
      for (const [key, value] of Object.entries(headers)) auth.response.headers.set(key, value);
      return auth.response;
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new CrmCommandError("JSON_REQUIRED", "JSON required", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new CrmCommandError("INVALID_INPUT", "JSON body required");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16_384) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Bounded provenance request required", 413); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CrmCommandError("INVALID_INPUT", "JSON object required");
    const result = await runQaLegacyProvenance(auth.session, body, crmRequestMetadata(request, body as Record<string, unknown>));
    return Response.json({ ...result.data, replayed: result.replayed, commandId: result.commandId, auditReference: result.auditReference }, { headers });
  } catch (error) {
    const response = crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
