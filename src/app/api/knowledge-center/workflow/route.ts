import { executeKnowledgeWorkflow, loadKnowledgeWorkflow, type KnowledgeWorkflowInput } from "@/lib/knowledge-center/workflow";
import { assertKnowledgeFields, knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError, knowledgeId } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
const fields: Readonly<Record<string, readonly string[]>> = {
  submit: ["sourceId", "versionId", "expectedVersion", "reason"], review: ["sourceId", "versionId", "expectedVersion", "reason"],
  approve: ["sourceId", "versionId", "expectedVersion", "reason"], publish: ["sourceId", "versionId", "expectedVersion", "reason"],
  restore: ["sourceId", "versionId", "expectedVersion", "reason", "confirmCurrentness", "confirmLegal"], revoke: ["sourceId", "versionId", "expectedVersion", "reason"],
  "proposal-edit": ["proposalId", "proposalRevision", "reason", "changes"], "proposal-accept": ["proposalId", "proposalRevision", "reason"],
  "proposal-reject": ["proposalId", "proposalRevision", "reason"], "proposal-defer": ["proposalId", "proposalRevision", "reason"],
  analyze: ["areaId"], configure: ["areaId", "fields", "staleAfterDays", "reason", "enabled"],
};
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    const params = knowledgeQueryParams(request, ["sourceId"]);
    const sourceId = params.has("sourceId") ? knowledgeId(params.get("sourceId"), "sourceId") : undefined;
    return knowledgeJson(await loadKnowledgeWorkflow(session, { sourceId }));
  });
}
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["action", ...new Set(Object.values(fields).flat())]);
    if (typeof body.action !== "string" || !Object.hasOwn(fields, body.action)) throw new KnowledgeCenterError("VALIDATION_ERROR", "Unknown knowledge workflow action.");
    assertKnowledgeFields(body, ["action", ...fields[body.action]]);
    return knowledgeJson(await executeKnowledgeWorkflow(session, body as KnowledgeWorkflowInput));
  });
}
