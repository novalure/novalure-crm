import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, executeCrmCommand, withCrmRead } from "@/lib/crm-command";
import { computeLeadPropertyMatches, getLeadQualification, qualificationLead, reviewLeadQualificationProof, saveLeadMatchingProfile, uploadLeadQualificationProof } from "@/lib/lead-qualification-repository";
import { MediaStoreError } from "@/lib/media-store";
import type { LeadProofKind, LeadProofStatus } from "@/lib/lead-qualification-types";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { return Response.json(await getLeadQualification(auth.session, assertCrmUuid(new URL(request.url).searchParams.get("leadId"))), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" }); if (!auth.ok) return auth.response;
  let correlationId: string | undefined;
  try {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      if (Number(request.headers.get("content-length")) > 4.25 * 1024 * 1024) throw new CrmCommandError("FILE_TOO_LARGE", "Nachweise dürfen höchstens 4 MB groß sein.", 413);
      const form = await request.formData(), file = form.get("file");
      if (!(file instanceof File)) throw new CrmCommandError("FILE_REQUIRED", "Bitte eine Datei wählen.");
      const metadata = crmRequestMetadata(request, {}); correlationId = metadata.correlationId;
      const result = await uploadLeadQualificationProof(auth.session, { leadId: assertCrmUuid(form.get("leadId")), kind: String(form.get("kind")) as LeadProofKind, purpose: String(form.get("purpose") ?? ""), usableDays: Number(form.get("usableDays")), file }, metadata);
      return Response.json({ ...result, persisted: true }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const encoded = await request.text(); if (encoded.length > 20000) throw new CrmCommandError("REQUEST_TOO_LARGE", "Anfrage ist zu groß.", 413);
    const input: unknown = JSON.parse(encoded); if (!input || typeof input !== "object" || Array.isArray(input)) throw new CrmCommandError("INVALID_REQUEST", "Objekt erwartet.");
    const body = input as Record<string, unknown>; assertCrmFields(body, ["operation", "leadId", "proofId", "expectedVersion", "status", "reason", "profile", "idempotencyKey", "correlationId"]);
    if (!["profile", "match", "review"].includes(String(body.operation))) throw new CrmCommandError("INVALID_OPERATION", "Unbekannte Aktion.");
    const leadId = assertCrmUuid(body.leadId), metadata = crmRequestMetadata(request, body); correlationId = metadata.correlationId;
    const projectId=await withCrmRead(auth.session,async(tx,fresh)=>String((await qualificationLead(tx,fresh,leadId)).project_id));
    const result = await executeCrmCommand(auth.session, { operation: `lead_qualification.${body.operation}`, resourceId: leadId, projectId, capability: "pipeline:write", ...metadata, payload: body }, async (tx, context) => {
      if (body.operation === "profile") return saveLeadMatchingProfile(tx, context.session, leadId, body.profile);
      if (body.operation === "review") return reviewLeadQualificationProof(tx, context.session, { leadId, proofId: assertCrmUuid(body.proofId), expectedVersion: body.expectedVersion as number, status: body.status as Exclude<LeadProofStatus, "pending">, reason: body.reason as string });
      return computeLeadPropertyMatches(tx, context.session, leadId);
    });
    return Response.json({ ...result, persisted: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof MediaStoreError) return crmCommandErrorResponse(new CrmCommandError(error.code, error.message, error.code.endsWith("STORAGE_UNAVAILABLE") ? 503 : 400), correlationId);
    return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Ungültige Anfrage.") : error, correlationId);
  }
}
