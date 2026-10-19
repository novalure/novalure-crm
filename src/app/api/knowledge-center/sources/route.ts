import { createKnowledgeSource } from "@/lib/knowledge-center/repository";
import { knowledgeContentFields, knowledgeJson, knowledgeQueryParams, parseKnowledgeSource, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["areaId", "type", ...knowledgeContentFields]);
    const source = await createKnowledgeSource(session, parseKnowledgeSource(body));
    return knowledgeJson({ source, version: source.version }, 201);
  });
}
