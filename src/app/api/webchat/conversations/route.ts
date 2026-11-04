import { knowledgeJson, knowledgeQueryParams, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { readWebchatConversationMessages } from "@/lib/webchat-customer-portal";

export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    const params = knowledgeQueryParams(request, ["conversationId", "before", "beforeId"]);
    const cursor = params.has("before") || params.has("beforeId") ? { createdAt: params.get("before") ?? "", id: params.get("beforeId") ?? "" } : undefined;
    return knowledgeJson(await readWebchatConversationMessages(session, { conversationId: params.get("conversationId") ?? "", cursor }));
  });
}
