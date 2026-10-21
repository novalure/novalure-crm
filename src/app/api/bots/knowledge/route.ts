import { createKnowledgeSource, loadKnowledgeCenter, queryKnowledgeCenter } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, parseKnowledgeQuery, parseKnowledgeSource, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";

/** Compatibility entry point; the same tenant, approval and channel rules apply. */
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    const params = knowledgeQueryParams(request, ["query", "q", "limit", "botId", "channel"]);
    const query = params.get("query") ?? params.get("q");
    if (query !== null) {
      if (!params.get("botId") || !params.get("channel")) throw new KnowledgeCenterError("BOT_CONTEXT_REQUIRED", "Knowledge bot retrieval requires an explicit bot and channel.");
      const input = parseKnowledgeQuery({ query, botId: params.get("botId"), channel: params.get("channel"), ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}) });
      const result = await queryKnowledgeCenter(session, input);
      return knowledgeJson({ source: "database", query: input.query, results: result.matches, grounded: result.grounded });
    }
    const snapshot = await loadKnowledgeCenter(session);
    return knowledgeJson({ source: "database", sources: snapshot.sources, available: snapshot.available });
  });
}

export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    // Approval is deliberately absent: callers can create drafts only. Publication
    // is a separate current-version command with server-side administrator checks.
    const body = await readKnowledgeJson(request, ["areaId", "title", "contentOrLocation", "sourceType", "mediaAssetId", "structuredData"]);
    const type = body.sourceType === "text" || body.sourceType === undefined ? "manual" : body.sourceType;
    const source = await createKnowledgeSource(session, parseKnowledgeSource({ areaId: body.areaId, name: body.title, type, ...(type === "url" ? { url: body.contentOrLocation } : { content: body.contentOrLocation }), ...(body.mediaAssetId === undefined ? {} : { mediaAssetId: body.mediaAssetId }), ...(body.structuredData === undefined ? {} : { structuredData: body.structuredData }) }));
    return knowledgeJson({ sourceId: source.id, source, status: "review_required", approval: "review", embeddedChunkCount: 0, persisted: true }, 201);
  });
}
