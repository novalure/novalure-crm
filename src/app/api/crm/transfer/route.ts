import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { CRM_TRANSFER_MAX_BYTES, CrmTransferError, type CrmTransferMapping } from "@/lib/crm-transfer";
import { commitCrmImport, exportCrmTransfer, previewCrmImport } from "@/lib/crm-transfer-repository";

const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function errorResponse(error: unknown) {
  const response = crmCommandErrorResponse(error instanceof CrmTransferError ? new CrmCommandError("INVALID_CSV", error.message) : error);
  Object.entries(privateHeaders).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) return auth.response;
    const query = new URL(request.url).searchParams;
    const kind = query.get("kind") ?? "contacts", format = query.get("format") ?? "csv";
    if (!["contacts", "leads"].includes(kind) || !["csv", "vcf"].includes(format)) throw new CrmCommandError("INVALID_EXPORT", "Bitte Kontakte oder Leads und ein gültiges Dateiformat auswählen.");
    const result = await exportCrmTransfer(auth.session, {
      kind: kind as "contacts" | "leads", format: format as "csv" | "vcf", projectId: query.get("projectId") || undefined,
      ids: query.has("ids") ? query.get("ids")!.split(",") : undefined,
    });
    return new Response(result.content, { headers: { ...privateHeaders, "content-type": result.contentType, "content-disposition": `attachment; filename="${result.filename}"`, "x-novalure-record-count": String(result.count) } });
  } catch (error) { return errorResponse(error); }
}

async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new CrmCommandError("INVALID_REQUEST", "JSON ist erforderlich.");
  if (!request.body) throw new CrmCommandError("INVALID_REQUEST", "Die Datei fehlt.");
  const limit = CRM_TRANSFER_MAX_BYTES * 3;
  if (Number(request.headers.get("content-length") || 0) > limit) throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Die Datei ist zu groß.", 413);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Die Datei ist zu groß.", 413); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CrmCommandError("INVALID_JSON", "Die Anfrage enthält kein gültiges JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmCommandError("INVALID_REQUEST", "Ein JSON-Objekt ist erforderlich.");
  return value as Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
    if (!auth.ok) return auth.response;
    const body = await boundedBody(request);
    if (!["preview", "commit"].includes(String(body.action)) || typeof body.csv !== "string" || typeof body.projectId !== "string" || typeof body.createLeads !== "boolean") throw new CrmCommandError("INVALID_REQUEST", "Datei, Zielprojekt und Importart sind erforderlich.");
    if (body.mapping !== undefined && (!body.mapping || typeof body.mapping !== "object" || Array.isArray(body.mapping) || Object.values(body.mapping).some(value => typeof value !== "string"))) throw new CrmCommandError("INVALID_MAPPING", "Die Feldzuordnung ist ungültig.");
    const input = { csv: body.csv, projectId: body.projectId, createLeads: body.createLeads, mapping: body.mapping as CrmTransferMapping | undefined };
    if (body.action === "preview") return Response.json({ preview: await previewCrmImport(auth.session, input) }, { headers: privateHeaders });
    const metadata = crmRequestMetadata(request, body);
    const result = await commitCrmImport(auth.session, { ...input, ...metadata });
    return Response.json({ ...result.data, replayed: result.replayed, auditReference: result.auditReference, commandId: result.commandId }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
