import { publishKnowledgeSource } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { knowledgeId, knowledgeRevision } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["sourceId", "versionId", "expectedVersion"]);
    const source = await publishKnowledgeSource(session, { sourceId: knowledgeId(body.sourceId, "sourceId"), versionId: knowledgeId(body.versionId, "versionId"), expectedVersion: knowledgeRevision(body.expectedVersion) });
    return knowledgeJson({ source });
  });
}
