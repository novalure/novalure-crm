import { runKnowledgeWebsiteScan } from "@/lib/knowledge-center/monitoring";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { knowledgeId, knowledgeRevision } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["sourceId", "expectedVersion"]);
    const result = await runKnowledgeWebsiteScan(session, { sourceId: knowledgeId(body.sourceId, "sourceId"), expectedVersion: knowledgeRevision(body.expectedVersion) });
    return knowledgeJson(result, result.run.status === "changed" && !result.busy ? 201 : 200);
  });
}
