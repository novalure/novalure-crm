import { archiveKnowledgeArea, updateKnowledgeArea } from "@/lib/knowledge-center/repository";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeText } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ areaId: string }> }) {
  return withKnowledgeRequest(request, async (session) => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["action", "name", "description"]);
    const { areaId } = await context.params;
    const id = knowledgeId(areaId, "areaId");
    if (body.action === "update") return knowledgeJson({ area: await updateKnowledgeArea(session, { areaId: id, name: knowledgeText(body.name, "name", 160), ...(body.description === undefined ? {} : { description: knowledgeText(body.description, "description", 2000, false) }) }) });
    if (body.action !== "archive" || body.name !== undefined || body.description !== undefined) throw new KnowledgeCenterError("VALIDATION_ERROR", "Invalid knowledge area action.");
    return knowledgeJson({ area: await archiveKnowledgeArea(session, { areaId: id }) });
  });
}
