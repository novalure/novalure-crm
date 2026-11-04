import { knowledgeJson, knowledgeQueryParams, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { readWebchatCustomerPortal } from "@/lib/webchat-customer-portal";

export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    const params = knowledgeQueryParams(request, ["before", "beforeId"]);
    const cursor = params.has("before") || params.has("beforeId") ? { updatedAt: params.get("before") ?? "", id: params.get("beforeId") ?? "" } : undefined;
    return knowledgeJson(await readWebchatCustomerPortal(session, {}, cursor));
  });
}
