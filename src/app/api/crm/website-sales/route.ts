import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { getWebsiteSalesIrelandWorkflow, runWebsiteSalesIrelandCommand, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "@/lib/db/website-sales-ireland-repositories";

async function boundedBody(request: Request): Promise<string> {
  const limit = 131072;
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Request is too large", 413);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Request is too large", 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const query = new URL(request.url).searchParams;
    const data = await getWebsiteSalesIrelandWorkflow(auth.session, { projectId: query.get("projectId") ?? "", companyId: query.get("companyId") ?? "", locationId: query.get("locationId") ?? "" });
    return Response.json({ data, contractVersion: websiteSalesIrelandContract }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return crmCommandErrorResponse(error); }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  let correlationId: string | undefined;
  try {
    const body = await boundedBody(request);
    const raw: unknown = JSON.parse(body);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    const input = raw as Record<string, unknown>;
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = await runWebsiteSalesIrelandCommand(auth.session, { ...input, ...metadata } as WebsiteSalesIrelandCommand);
    return Response.json({ ...result, persisted: true, contractVersion: websiteSalesIrelandContract, correlationId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error, correlationId); }
}
