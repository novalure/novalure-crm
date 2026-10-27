import { externalAssistantKnowledgeOptions, handleExternalAssistantKnowledgeRequest } from "@/lib/knowledge-center/external-assistant-http";

export const runtime = "nodejs";
export async function POST(request: Request) { return handleExternalAssistantKnowledgeRequest(request); }
export const OPTIONS = externalAssistantKnowledgeOptions;
