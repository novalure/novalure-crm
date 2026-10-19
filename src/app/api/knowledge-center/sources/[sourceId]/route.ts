import { archiveKnowledgeSource } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["action", "expectedVersion"]);
    if (body.action !== "archive") throw new KnowledgeCenterError("VALIDATION_ERROR", "Invalid knowledge source action.");
    const { sourceId } = await context.params;
    return knowledgeJson({ source: await archiveKnowledgeSource(session, { sourceId: knowledgeId(sourceId, "sourceId"), expectedVersion: knowledgeRevision(body.expectedVersion) }) });
  });
}
