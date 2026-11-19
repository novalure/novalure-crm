import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { createCrmOnboardingExample, loadCrmOnboarding, saveCrmOnboardingProgress } from "@/lib/db/crm-onboarding-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { const data = await withCrmRead(auth.session, loadCrmOnboarding); return Response.json({ data, persisted: true }, { headers }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request);
    if (Object.keys(body).some((key) => !["action", "progress", "expectedRevision", "countryCode", "confirmed"].includes(key))) throw new CrmCommandError("INVALID_INPUT", "Onboardingfelder prüfen");
    if (body.action === "progress") {
      const data = await withCrmRead(auth.session, (tx, session) => saveCrmOnboardingProgress(tx, session, body.progress, Number(body.expectedRevision), assertCrmUuid(request.headers.get("idempotency-key"))));
      return Response.json({ data, persisted: true }, { headers });
    }
    if (body.action === "create_example") {
      if (body.confirmed !== true || !auth.session.permissions.includes("crm:write")) throw new CrmCommandError("FORBIDDEN", "Anlage eines getrennten fiktiven Beispielprojekts ausdrücklich bestätigen", 403);
      const result = await createCrmOnboardingExample(auth.session, body.countryCode, crmRequestMetadata(request, body));
      return Response.json({ data: result.data, persisted: true, replayed: result.replayed, sent: false, published: false }, { headers });
    }
    throw new CrmCommandError("INVALID_ACTION", "Onboardingaktion prüfen");
  } catch (error) { return crmCommandErrorResponse(error); }
}
