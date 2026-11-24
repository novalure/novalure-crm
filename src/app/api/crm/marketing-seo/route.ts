import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { readSeoWorkspace, mutateSeoWorkspace } from "@/lib/db/marketing-seo-repository";
import { SEO_IMPORT_MAX_BYTES } from "@/lib/marketing-seo";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
function failure(error: unknown) { const response = crmCommandErrorResponse(error); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response; }
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const query = new URL(request.url).searchParams, projectId = query.get("projectId"), reportId = query.get("reportId");
    return Response.json(await readSeoWorkspace(auth.session, projectId ? assertCrmUuid(projectId) : null, reportId ? assertCrmUuid(reportId) : undefined), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" });
    if (!auth.ok) return auth.response;
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) throw new CrmCommandError("INVALID_REQUEST", "JSON is required.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > SEO_IMPORT_MAX_BYTES) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "SEO import exceeds 2 MB.", 413); } chunks.push(part.value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: Record<string, unknown>;
    try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); body = value as Record<string, unknown>; } catch { throw new CrmCommandError("INVALID_REQUEST", "Invalid SEO JSON."); }
    const metadata = crmRequestMetadata(request, body); delete body.idempotencyKey; delete body.correlationId;
    const result = await mutateSeoWorkspace(auth.session, body, metadata);
    return Response.json({ ...result.data, replayed: result.replayed, auditReference: result.auditReference }, { headers });
  } catch (error) { return failure(error); }
}
