import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, CrmCommandError } from "@/lib/crm-command";
import { getLeadProofAsset } from "@/lib/lead-qualification-repository";
import { readMediaAssetContent } from "@/lib/media-store";
import { safeMediaContentDisposition } from "@/lib/media-security";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ proofId: string }> }) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const { proofId } = await context.params, asset = await getLeadProofAsset(auth.session, proofId);
    if (!asset) throw new CrmCommandError("PROOF_UNAVAILABLE", "Nachweis ist nicht verfügbar.", 404);
    const content = await readMediaAssetContent(asset); if (!content) throw new CrmCommandError("PROOF_UNAVAILABLE", "Nachweis ist nicht verfügbar.", 404);
    return new Response(content.body, { headers: { "Cache-Control": "private, no-store", "Content-Type": content.contentType, "Content-Length": String(content.sizeBytes), "Content-Disposition": safeMediaContentDisposition(asset.originalName, content.contentType).replace(/^inline;/, "attachment;"), "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return crmCommandErrorResponse(error); }
}
