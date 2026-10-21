import { createKnowledgeArea } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, parseKnowledgeArea, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["name", "kind", "projectId", "description"]);
    return knowledgeJson({ area: await createKnowledgeArea(session, parseKnowledgeArea(body)) }, 201);
  });
}
