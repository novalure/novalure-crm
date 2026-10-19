import { loadKnowledgeCenter } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, withKnowledgeRequest } from "@/lib/knowledge-center/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    return knowledgeJson({ snapshot: await loadKnowledgeCenter(session) });
  });
}
