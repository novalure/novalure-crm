import { listKnowledgeVersions, updateKnowledgeSource } from "@/lib/knowledge-center/repository";
import { knowledgeContentFields, knowledgeJson, knowledgeQueryParams, parseKnowledgeVersion, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { knowledgeId } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    const params = knowledgeQueryParams(request, ["sourceId"]);
    return knowledgeJson({ versions: await listKnowledgeVersions(session, { sourceId: knowledgeId(params.get("sourceId"), "sourceId") }) });
  });
}
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["sourceId", "expectedVersion", ...knowledgeContentFields]);
    const source = await updateKnowledgeSource(session, parseKnowledgeVersion(body));
    return knowledgeJson({ source, version: source.version }, 201);
  });
}
