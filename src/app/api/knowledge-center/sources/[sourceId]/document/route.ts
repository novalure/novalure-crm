import { withCrmRead } from "@/lib/crm-command";
import { authorizedKnowledgeMediaAsset, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";
import { safeMediaContentDisposition } from "@/lib/media-security";
import { getKnowledgeDocument } from "@/lib/knowledge-center/repository";
import { knowledgePrivateHeaders, knowledgeQueryParams, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const { sourceId } = await context.params;
    const asset = await withCrmRead(session, async (_tx, fresh) => {
      const document = await getKnowledgeDocument(fresh, { sourceId: knowledgeId(sourceId, "sourceId") });
      return authorizedKnowledgeMediaAsset(document.assetId, fresh.workspaceId);
    });
    if (!asset) throw new KnowledgeCenterError("NOT_FOUND", "Knowledge document is unavailable.", 404);
    try {
      const content = await readMediaAssetContent(asset);
      if (!content) throw new KnowledgeCenterError("NOT_FOUND", "Knowledge document is unavailable.", 404);
      return new Response(content.body, { headers: {
        ...knowledgePrivateHeaders,
        "content-security-policy": "sandbox; default-src 'none'",
        "cross-origin-resource-policy": "same-origin",
        "content-disposition": safeMediaContentDisposition(asset.originalName, content.contentType).replace(/^inline;/, "attachment;"),
        "content-length": String(content.sizeBytes),
        "content-type": content.contentType,
      } });
    } catch (error) {
      if (error instanceof MediaStoreError) throw new KnowledgeCenterError("DOCUMENT_UNAVAILABLE", "Document storage is temporarily unavailable.", 503);
      throw error;
    }
  });
}
