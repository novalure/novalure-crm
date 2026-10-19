import { getKnowledgeMonitoring, parseKnowledgeMonitoringInterval, saveKnowledgeMonitoring } from "@/lib/knowledge-center/monitoring";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    const params = knowledgeQueryParams(request, ["sourceId"]);
    return knowledgeJson(await getKnowledgeMonitoring(session, { sourceId: knowledgeId(params.get("sourceId"), "sourceId") }));
  });
}
export async function PUT(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["sourceId", "expectedVersion", "interval", "enabled"]);
    if (typeof body.enabled !== "boolean") throw new KnowledgeCenterError("VALIDATION_ERROR", "An explicit enabled value is required.");
    const config = await saveKnowledgeMonitoring(session, { sourceId: knowledgeId(body.sourceId, "sourceId"), expectedVersion: knowledgeRevision(body.expectedVersion), interval: parseKnowledgeMonitoringInterval(body.interval), enabled: body.enabled });
    return knowledgeJson({ config });
  });
}
