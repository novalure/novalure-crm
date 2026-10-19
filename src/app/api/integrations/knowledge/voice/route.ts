import { handleMachineKnowledgeRequest } from "@/lib/knowledge-center/assistant-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleMachineKnowledgeRequest(request, "voice");
}
