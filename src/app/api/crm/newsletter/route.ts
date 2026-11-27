import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "@/lib/crm-command";
import { NewsletterWorkspaceError } from "@/lib/newsletter-workspace";
import { approveNewsletter, createNewsletterDraft, previewNewsletterRecipients, previewNewsletterAudience,configureNewsletterMarketing,readNewsletterWorkspace, saveNewsletterDraft, sendNewsletterBatch, sendNewsletterTest } from "@/lib/db/newsletter-workspace-repository";
export const maxDuration = 300;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function failure(error: unknown) { const response = crmCommandErrorResponse(error instanceof NewsletterWorkspaceError ? new CrmCommandError("INVALID_MAILING", error.message) : error); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response; }
export async function GET(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
    const query = new URL(request.url).searchParams;
    if(query.get('segmentId'))return Response.json(await previewNewsletterAudience(auth.session,query.get('projectId')||'',query.get('segmentId')!),{headers});
    return Response.json(query.get("campaignId") ? await previewNewsletterRecipients(auth.session, query.get("campaignId")!) : await readNewsletterWorkspace(auth.session, query.get("projectId") || undefined), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" }); if (!auth.ok) return auth.response;
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) throw new CrmCommandError("INVALID_REQUEST", "JSON ist erforderlich.");
    const reader = request.body.getReader(), parts: Uint8Array[] = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 750000) { await reader.cancel(); throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Der Mailingentwurf ist zu groß.", 413); } parts.push(part.value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    let body: Record<string, unknown>;
    try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); body = value; } catch { throw new CrmCommandError("INVALID_JSON", "Ungültige Mailinganfrage."); }
    const metadata = crmRequestMetadata(request, body);
    const fields = body.action==='configure'?['action','campaignId','expectedRevision','segmentId','templateId','templateRevision','language','idempotencyKey','correlationId']:body.action === "create" ? ["action", "projectId", "name", "audience", "language", "idempotencyKey", "correlationId"] : body.action === "save" ? ["action", "campaignId", "expectedRevision", "draft", "idempotencyKey", "correlationId"] : ["action", "campaignId", "expectedRevision", "idempotencyKey", "correlationId"];
    if (Object.keys(body).some(key => !fields.includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Die Mailinganfrage enthält unbekannte Felder.");
    if (body.action === "create") {
      if (typeof body.projectId !== "string" || typeof body.name !== "string" || typeof body.audience !== "string" || !["de", "en", "es"].includes(String(body.language))) throw new CrmCommandError("INVALID_REQUEST", "Projekt, Name und Zielgruppe sind erforderlich.");
      const result = await createNewsletterDraft(auth.session, { projectId: body.projectId, name: body.name, audience: body.audience, language: body.language as "de" | "en" | "es" }, metadata);
      return Response.json({ ...result.data, replayed: result.replayed }, { headers });
    }
    if (typeof body.campaignId !== "string" || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new CrmCommandError("INVALID_REQUEST", "Mailing-ID und gespeicherte Version sind erforderlich.");
    const input = { campaignId: body.campaignId, expectedRevision: body.expectedRevision };
    if(body.action==='configure'){
      if((body.segmentId!==undefined&&typeof body.segmentId!=='string')||(body.templateId!==undefined&&(typeof body.templateId!=='string'||!Number.isSafeInteger(body.templateRevision)||Number(body.templateRevision)<1||!['de','en','es'].includes(String(body.language)))))throw new CrmCommandError('INVALID_REQUEST','Vorlagenrevision, Sprache bzw. Zielgruppe fehlt.');
      const result=await configureNewsletterMarketing(auth.session,{...input,...(body.segmentId?{segmentId:body.segmentId as string}:{}),...(body.templateId?{templateId:body.templateId as string,templateRevision:body.templateRevision as number,language:body.language as 'de'|'en'|'es'}:{})},metadata);return Response.json({...result.data,replayed:result.replayed},{headers});
    }
    if (body.action === "save") { const result = await saveNewsletterDraft(auth.session, { ...input, draft: body.draft }, metadata); return Response.json({ ...result.data, replayed: result.replayed }, { headers }); }
    if (body.action === "approve") { const result = await approveNewsletter(auth.session, input, metadata); return Response.json({ ...result.data, replayed: result.replayed }, { headers }); }
    if (body.action === "send") return Response.json(await sendNewsletterBatch(auth.session, input, metadata), { headers });
    if (body.action === "test") return Response.json(await sendNewsletterTest(auth.session, input, metadata), { headers });
    throw new CrmCommandError("INVALID_ACTION", "Die Mailingaktion ist ungültig.");
  } catch (error) { return failure(error); }
}
