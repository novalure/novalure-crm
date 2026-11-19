import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { createWebchatTopupOrder } from "@/lib/webchat-product/billing";
import { knowledgeId, knowledgeRevision, knowledgeText } from "@/lib/knowledge-center/policy";

export async function POST(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["requestId", "offerReference", "expectedOfferRevision"], 8192);
    const result = await createWebchatTopupOrder(session, { requestId: knowledgeId(body.requestId, "requestId"), offerReference: knowledgeText(body.offerReference, "offerReference", 160), expectedOfferRevision: knowledgeRevision(body.expectedOfferRevision) });
    return knowledgeJson({ order: { id: result.orderId, status: result.status, units: result.units }, replayed: result.replayed }, result.replayed ? 200 : 201);
  });
}
