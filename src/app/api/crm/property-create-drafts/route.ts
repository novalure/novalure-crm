import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { completePropertyCreationDraft, loadPropertyCreationDrafts, savePropertyCreationDraft } from "@/lib/db/property-create-draft-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" }); if (!auth.ok) return auth.response;
  try { return Response.json({ data: await withCrmRead(auth.session, loadPropertyCreationDrafts), persisted: true }, { headers }); } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request);
    if (body.action === "complete") {
      assertCrmFields(body, ["action", "id", "expectedRevision"]);
      const result = await completePropertyCreationDraft(auth.session, { id: body.id, expectedRevision: body.expectedRevision }, crmRequestMetadata(request, body));
      return Response.json({ data: result.data, persisted: true, replayed: result.replayed, published: false, sent: false }, { headers });
    }
    if (body.action !== "save" && body.action !== "discard") throw new CrmCommandError("INVALID_ACTION", "Entwurfsaktion prüfen");
    assertCrmFields(body, ["action", "id", "draft", "step", "expectedRevision"]);
    const data = await withCrmRead(auth.session, (tx, session) => savePropertyCreationDraft(tx, session, { id: body.id, draft: body.draft, step: body.step, expectedRevision: body.expectedRevision, discard: body.action === "discard", requestId: assertCrmUuid(request.headers.get("idempotency-key")) }));
    return Response.json({ data, persisted: true }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
