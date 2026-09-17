import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from "@/lib/crm-command";
import { reconcileSalesHttp } from "@/lib/crm-sales-http";
import { reconcileOfferCommand, type OfferCommand } from "@/lib/db/offer-repositories";
/** Authenticated result lookup only. This route never calls an effect handler. */
export async function POST(request: Request) {
  let correlationId: string | undefined;
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
    if (!auth.ok) return auth.response;
    const input = await request.json() as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    assertCrmFields(input, ["target", "method", "body"]);
    if (typeof input.target !== "string" || typeof input.method !== "string" || !input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new CrmCommandError("INVALID_REQUEST", "Original CRM request required");
    const metadata = crmRequestMetadata(request, {}); correlationId = metadata.correlationId;
    if (/^\/api\/crm\/offers(?:\?|$)/.test(input.target) && input.method === "POST") {
      const result = await reconcileOfferCommand(auth.session, { ...input.body, ...metadata } as OfferCommand);
      return Response.json(result.status === "COMMITTED" ? { ...result, response: { status: 200, body: { data: result.data, replayed: true, persisted: true, commandId: result.commandId, auditReference: result.auditReference, correlationId, contractVersion: "1" } } } : result, { headers: { "Cache-Control": "no-store" } });
    }
    const result = await reconcileSalesHttp(auth.session, { target: input.target, method: input.method, body: input.body as Record<string, unknown>, ...metadata });
    return Response.json(result.status === "COMMITTED" ? { ...result, response: result.data } : result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error, correlationId); }
}
