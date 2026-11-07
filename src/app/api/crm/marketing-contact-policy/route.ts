import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { readMarketingContactPolicy, saveMarketingContactPolicy } from "@/lib/db/marketing-contact-policy-repository";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { return Response.json(await readMarketingContactPolicy(auth.session), { headers }); } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" }); if (!auth.ok) return auth.response;
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) throw new CrmCommandError("INVALID_REQUEST", "Versandregeln müssen als JSON übertragen werden.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 12000) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Versandregeln sind zu groß.", 413); } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let body: Record<string, unknown>; try { body = JSON.parse(bodyText); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); } catch { throw new CrmCommandError("INVALID_JSON", "Ungültige Versandregeln."); }
    assertCrmFields(body, ["expectedRevision", "rules", "idempotencyKey", "correlationId"]);
    if (typeof body.expectedRevision !== "number") throw new CrmCommandError("VERSION_REQUIRED", "Regelrevision fehlt.", 409);
    const result = await saveMarketingContactPolicy(auth.session, { expectedRevision: body.expectedRevision, rules: body.rules }, crmRequestMetadata(request, body));
    return Response.json({ ...result.data, replayed: result.replayed }, { headers });
  } catch (error) { const response = crmCommandErrorResponse(error); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response; }
}
