import { listCrmBotTools, runCrmBotTool } from "@/lib/bots/agent-tools";
import { requirePermission } from "@/lib/auth/session";
import {
  documentApprovedFromPayload,
  evaluateBotAction,
  getBotPolicyRules,
  getBotRuntimeControls,
  type BotActionName,
  type BotActionRisk,
} from "@/lib/bots/policy";
import { createApprovalRequest, insertBotToolCall, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function policyActionForTool(toolName: string): BotActionName {
  if (toolName === "search_approved_knowledge") return "knowledge_search";
  if (toolName === "capture_customer_data" || toolName === "qualify_lead") return "crm_upsert";
  if (toolName === "send_document") return "document_send";
  if (toolName === "book_meeting") return "meeting_book";
  if (toolName === "find_meeting_slots") return "meeting_prepare";
  if (toolName === "send_channel_reply" || toolName === "send_whatsapp_template") return "channel_reply";

  return "model_reply";
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "bots:run");

  if (!auth.ok) return auth.response;

  return Response.json({
    tools: listCrmBotTools(),
    approvalRequiredForWrites: false,
    autonomyControls: getBotRuntimeControls(),
    policyRules: getBotPolicyRules(),
    auditLogEnabled: true,
  });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermission(request, "bots:run");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const prompt = String("prompt" in body ? body.prompt : "").trim();

  if (!prompt) {
    return Response.json({ error: copy.promptRequired }, { status: 400 });
  }

  const toolName = String("tool" in body ? body.tool : "search_approved_knowledge");
  const tool = listCrmBotTools().find((item) => item.name === toolName);
  const input = "input" in body && typeof body.input === "object" && body.input
    ? body.input as Record<string, unknown>
    : { query: prompt };
  const controls = getBotRuntimeControls(body as Record<string, unknown>);
  const action = policyActionForTool(toolName);
  const decision = evaluateBotAction({
    action,
    controls,
    document: action === "document_send"
      ? {
          approved: documentApprovedFromPayload(input),
          publicUrl: getString(input.documentUrl),
          recipient: getString(input.recipientEmail) ?? getString(input.email) ?? getString(input.recipientPhone) ?? getString(input.phone),
        }
      : undefined,
    meeting: action === "meeting_book"
      ? {
          contactEmail: getString(input.contactEmail) ?? getString(input.email),
          contactName: getString(input.contactName) ?? getString(input.name) ?? getString(input.leadName),
          selectedDate: getString(input.selectedDate) ?? getString(input.date),
          slot: getString(input.slot) ?? getString(input.selectedSlot),
          slug: getString(input.slug) ?? getString(input.meetingPage) ?? getString(input.meetingSlug),
        }
      : undefined,
    risk: (tool?.riskLevel ?? "medium") as BotActionRisk,
  });
  const pendingManualApproval = decision.requiresHumanApproval && decision.reason === "manual_approval_override";
  const blocked = !decision.allowed && !pendingManualApproval;
  const result = blocked
    ? {
        decision,
        reason: decision.reason,
        status: "blocked",
        tool: toolName,
      }
    : runCrmBotTool(toolName, input);
  const requiresApproval = pendingManualApproval;
  const status = blocked ? "failed" : requiresApproval ? "pending_approval" : "completed";
  const runId = await insertBotToolCall({
    session: auth.session,
    conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
    botId: typeof input.botId === "string" ? input.botId : null,
    toolName,
    riskLevel: tool?.riskLevel ?? "medium",
    input,
    output: { decision, result },
    status,
    requiresApproval,
    error: blocked ? decision.reason : null,
  });
  const approvalId = requiresApproval
    ? await createApprovalRequest({
        session: auth.session,
        projectId: typeof input.projectId === "string" ? input.projectId : null,
        entityType: "bot_tool_call",
        entityId: runId,
        action: `tool.${toolName}.approve`,
        summary:
          language === "de"
            ? `Tool-Ausführung ${toolName} freigeben`
            : `Approve tool execution ${toolName}`,
        payload: { decision, prompt, input, result },
      })
    : null;

  await writeAuditLog({
    session: auth.session,
    action: `tool.${toolName}.${status}`,
    entityType: "bot_tool_call",
    entityId: runId,
    after: { decision, input, result, approvalId },
  });

  return Response.json({
    runId: runId ?? crypto.randomUUID(),
    approvalId,
    decision,
    status,
    result,
    auditEvents: ["agent.requested", `tool.${toolName}.executed`],
  }, { status: blocked ? 409 : 200 });
}
