import { assignKnowledgeAreas } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, parseKnowledgeAssignment, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["botId", "channel", "areaIds"]);
    return knowledgeJson({ assignments: await assignKnowledgeAreas(session, parseKnowledgeAssignment(body)) });
  });
}
