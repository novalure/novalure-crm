import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { deleteOwnLearningSignal, readPrivateLearningHistory } from "@/lib/shared-behavior/management";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    return knowledgeJson(await readPrivateLearningHistory(session));
  });
}
export async function DELETE(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    const body = await readKnowledgeJson(request, ["eventId"], 512);
    return knowledgeJson(await deleteOwnLearningSignal(session, body.eventId));
  });
}
