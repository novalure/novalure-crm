import { queryKnowledgeCenter } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, parseKnowledgeQuery, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["query", "botId", "channel", "areaIds", "limit"]);
    return knowledgeJson(await queryKnowledgeCenter(session, parseKnowledgeQuery(body)));
  });
}
