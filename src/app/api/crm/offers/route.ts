import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { executeOfferCommand, getOfferWorkflow, type OfferCommand } from "@/lib/db/offer-repositories";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const data = await getOfferWorkflow(auth.session, new URL(request.url).searchParams.get("dealId") ?? "");
    return Response.json({ ...data, source: "database", contractVersion: "1" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  let correlationId: string | undefined;
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    const input = raw as Record<string, unknown>;
    assertCrmFields(input, ["operation", "offerId", "dealId", "projectId", "expectedVersion", "payload", "idempotencyKey", "correlationId"]);
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = await executeOfferCommand(auth.session, { ...input, ...metadata } as OfferCommand);
    return Response.json({ ...result, persisted: true, contractVersion: "1", correlationId });
  } catch (error) { return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error, correlationId); }
}
