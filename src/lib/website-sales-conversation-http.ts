import { ZodError } from "zod";
import { CrmCommandError, crmCommandErrorResponse, crmRequestMetadata } from "./crm-command";
import { readKnowledgeJson } from "./knowledge-center/http";
import { KnowledgeCenterError } from "./knowledge-center/policy";
import type { SalesConversationCommand } from "./website-sales-conversation-types";

export async function conversationCommandBody(request: Request): Promise<SalesConversationCommand> {
  const body = await readKnowledgeJson(request, ["contractVersion", "operation", "projectId", "companyId", "locationId", "expectedConversationVersion", "expectedWorkflowVersion", "idempotencyKey", "correlationId", "payload", "allocationProof"], 131072);
  const metadata = crmRequestMetadata(request, body);
  if (body.idempotencyKey !== metadata.idempotencyKey || body.correlationId !== metadata.correlationId) throw new CrmCommandError("METADATA_MISMATCH", "Exact original metadata required");
  return body as SalesConversationCommand;
}
export function conversationError(error: unknown): Response {
  if (error instanceof KnowledgeCenterError) return Response.json({ code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  return crmCommandErrorResponse(error instanceof ZodError ? new CrmCommandError("INVALID_CONVERSATION_PAYLOAD", "Invalid conversation payload", 400) : error);
}
