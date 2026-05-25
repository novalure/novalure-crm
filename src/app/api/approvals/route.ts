import { requirePermission, type AppSession } from "@/lib/auth/session";
import { queryOne, queryRows } from "@/lib/db/client";
import {
  canPersist,
  decideLeadWorkflowRun,
  insertBotMessage,
  isUuid,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

type ApprovalRow = {
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  summary: string;
  status: string;
  payload: unknown;
  createdAt: string;
};

type BotToolCallRow = {
  id: string;
  botId: string | null;
  conversationId: string | null;
  input: unknown;
  output: unknown;
  requiresApproval: boolean;
  status: string;
  toolName: string;
};

type ExecutedBotActions = {
  documentSendsCreated: number;
  meetingBookingsCreated: number;
  meetingProposalsPrepared: number;
};

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNestedRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getToolCallIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.toolCallIds)) return [];

  return payload.toolCallIds.filter((id): id is string => typeof id === "string" && isUuid(id));
}

function getConversationId(row: ApprovalRow): string | null {
  if (row.entityType === "bot_conversation" && isUuid(row.entityId)) {
    return row.entityId;
  }

  if (!isRecord(row.payload)) return null;

  const conversationId = typeof row.payload.conversationId === "string" ? row.payload.conversationId : null;
  return isUuid(conversationId) ? conversationId : null;
}

function getApprovalDecisionMessage(decision: "approved" | "denied" | "handoff", language: "de" | "en") {
  const messages = {
    de: {
      approved: "Freigabe erteilt: vorbereitete Bot-Aktionen können jetzt ausgeführt werden.",
      denied: "Freigabe abgelehnt: vorbereitete Bot-Aktionen wurden gestoppt.",
      handoff: "Mensch übernimmt: Das Bot-Gespräch wurde zur Übergabe markiert.",
    },
    en: {
      approved: "Approval granted: prepared bot actions can now be executed.",
      denied: "Approval denied: prepared bot actions have been stopped.",
      handoff: "Human takes over: the bot conversation was marked for handoff.",
    },
  };

  return messages[language][decision];
}

function getCustomerData(toolCalls: BotToolCallRow[]) {
  const customerDataTool = toolCalls.find((toolCall) => toolCall.toolName === "capture_customer_data");
  const output = isRecord(customerDataTool?.output) ? customerDataTool.output : null;
  const contact = output ? getNestedRecord(output, "contact") : null;

  return {
    email: contact ? getStringField(contact, "email") : null,
    name: contact ? getStringField(contact, "name") : null,
    phone: contact ? getStringField(contact, "phone") : null,
    preferredChannel: contact ? getStringField(contact, "preferredChannel") : null,
  };
}

function getFirstMeetingSlot(output: unknown) {
  if (!isRecord(output) || !Array.isArray(output.slots)) return null;

  for (const slot of output.slots) {
    if (!isRecord(slot)) continue;

    const value = getStringField(slot, "value");
    const label = getStringField(slot, "label");
    const startsAt = value ? new Date(value) : null;

    if (startsAt && !Number.isNaN(startsAt.getTime())) {
      return { label: label ?? value, startsAt, value };
    }
  }

  return null;
}

async function executeApprovedBotActions(input: {
  approvalId: string;
  conversationId: string | null;
  session: AppSession;
  toolCalls: BotToolCallRow[];
}) {
  const executed: ExecutedBotActions = {
    documentSendsCreated: 0,
    meetingBookingsCreated: 0,
    meetingProposalsPrepared: 0,
  };
  const customerData = getCustomerData(input.toolCalls);

  for (const toolCall of input.toolCalls) {
    const output = isRecord(toolCall.output) ? toolCall.output : {};
    const toolInput = isRecord(toolCall.input) ? toolCall.input : {};
    const conversationId = isUuid(toolCall.conversationId) ? toolCall.conversationId : input.conversationId;

    if (toolCall.toolName === "send_document") {
      const mediaAssetId =
        getStringField(output, "documentId") ?? getStringField(toolInput, "mediaAssetId") ?? getStringField(toolInput, "documentId");
      const documentName = getStringField(output, "documentName") ?? "Freigegebenes Dokument";
      const channel = getStringField(output, "channel") ?? getStringField(toolInput, "channel") ?? "Webchat";
      const row = await queryOne<{ id: string }>(
        `
          insert into bot_document_sends (
            workspace_id,
            bot_id,
            conversation_id,
            contact_id,
            media_asset_id,
            channel,
            document_name,
            status,
            approval_request_id,
            metadata
          )
          values (
            $1,
            $2,
            $3,
            (select contact_id from bot_conversations where id = $3 and workspace_id = $1),
            $4,
            $5,
            $6,
            'ready_to_send',
            $7,
            $8::jsonb
          )
          returning id
        `,
        [
          input.session.workspaceId,
          isUuid(toolCall.botId) ? toolCall.botId : null,
          isUuid(conversationId) ? conversationId : null,
          isUuid(mediaAssetId) ? mediaAssetId : null,
          channel,
          documentName,
          input.approvalId,
          JSON.stringify({ customerData, toolCallId: toolCall.id }),
        ],
      );

      if (row?.id) executed.documentSendsCreated += 1;
    }

    if (toolCall.toolName === "find_meeting_slots") {
      const firstSlot = getFirstMeetingSlot(output);
      const meetingPage = getStringField(output, "meetingPage") ?? getStringField(toolInput, "meetingPage") ?? "pipeline-audit";

      if (!firstSlot) continue;

      executed.meetingProposalsPrepared += 1;

      const row = await queryOne<{ id: string }>(
        `
          insert into meeting_bookings (
            workspace_id,
            meeting_page_id,
            contact_id,
            slug,
            title,
            contact_name,
            contact_email,
            contact_note,
            starts_at,
            ends_at,
            calendar_provider,
            meeting_provider,
            status,
            source,
            metadata
          )
          values (
            $1,
            (select id from meeting_pages where workspace_id = $1 and slug = $2 limit 1),
            (select contact_id from bot_conversations where id = $3 and workspace_id = $1),
            $2,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            'microsoft',
            'microsoft-teams',
            'requested',
            'bot_approval',
            $10::jsonb
          )
          on conflict do nothing
          returning id
        `,
        [
          input.session.workspaceId,
          meetingPage,
          isUuid(conversationId) ? conversationId : null,
          "Bot-Terminvorschlag",
          customerData.name ?? "Kontakt",
          customerData.email ?? "",
          customerData.phone ? `Telefon: ${customerData.phone}` : "",
          firstSlot.startsAt.toISOString(),
          addMinutes(firstSlot.startsAt, 30).toISOString(),
          JSON.stringify({
            approvalId: input.approvalId,
            customerData,
            proposedSlotLabel: firstSlot.label,
            toolCallId: toolCall.id,
          }),
        ],
      );

      if (row?.id) executed.meetingBookingsCreated += 1;
    }
  }

  return executed;
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "bots:approve");

  if (!auth.ok) return auth.response;

  if (!canPersist() || !isUuid(auth.session.workspaceId)) {
    return Response.json({ approvals: [], source: "demo" });
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "approved" || statusParam === "denied" || statusParam === "expired"
      ? statusParam
      : "pending";

  const approvals = await queryRows<ApprovalRow>(
    `
      select
        id,
        entity_type as "entityType",
        entity_id as "entityId",
        action,
        summary,
        status,
        payload,
        created_at as "createdAt"
      from approval_requests
      where workspace_id = $1 and status = $2
      order by created_at desc
      limit 100
    `,
    [auth.session.workspaceId, status],
  );

  return Response.json({ approvals, status, source: "database" });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermission(request, "bots:approve");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const approvalId = typeof input.approvalId === "string" ? input.approvalId : "";
  const decision =
    input.decision === "approved" || input.decision === "denied" || input.decision === "handoff"
      ? input.decision
      : null;

  if (!isUuid(approvalId) || !decision) {
    return Response.json({ error: copy.approvalRequired }, { status: 400 });
  }

  if (!canPersist() || !isUuid(auth.session.workspaceId)) {
    return Response.json({ error: "DATABASE_URL is not configured" }, { status: 503 });
  }

  const approvalStatus = decision === "handoff" ? "denied" : decision;

  const updated = await queryOne<ApprovalRow>(
    `
      update approval_requests
      set status = $3,
          decided_by_user_id = case when $4::uuid is null then decided_by_user_id else $4::uuid end,
          decided_at = now(),
          updated_at = now()
      where id = $1 and workspace_id = $2 and status = 'pending'
      returning
        id,
        entity_type as "entityType",
        entity_id as "entityId",
        action,
        summary,
        status,
        payload,
        created_at as "createdAt"
    `,
    [approvalId, auth.session.workspaceId, approvalStatus, isUuid(auth.session.userId) ? auth.session.userId : null],
  );

  if (!updated) {
    return Response.json({ error: "Approval not found" }, { status: 404 });
  }

  const toolCallIds = getToolCallIds(updated.payload);
  const toolCalls = toolCallIds.length
    ? await queryRows<BotToolCallRow>(
        `
          select
            id,
            bot_id as "botId",
            conversation_id as "conversationId",
            input,
            output,
            requires_approval as "requiresApproval",
            status,
            tool_name as "toolName"
          from bot_tool_calls
          where workspace_id = $1
            and id = any($2::uuid[])
        `,
        [auth.session.workspaceId, toolCallIds],
      )
    : [];
  const toolCallStatus = decision === "approved" ? "approved" : "denied";
  const toolCallError =
    decision === "approved"
      ? null
      : decision === "handoff"
        ? "Human handoff requested before execution"
        : "Approval denied";
  let updatedToolCalls = 0;

  if (toolCallIds.length) {
    const toolCallRows = await queryRows<{ id: string }>(
      `
        update bot_tool_calls
        set status = $3,
            approved_by_user_id = case when $4::uuid is null then approved_by_user_id else $4::uuid end,
            approved_at = case when $3 = 'approved' then now() else approved_at end,
            error = $5,
            updated_at = now()
        where workspace_id = $1
          and id = any($2::uuid[])
          and status in ('pending_approval', 'approved', 'denied')
        returning id
      `,
      [
        auth.session.workspaceId,
        toolCallIds,
        toolCallStatus,
        isUuid(auth.session.userId) ? auth.session.userId : null,
        toolCallError,
      ],
    );

    updatedToolCalls = toolCallRows.length;
  }

  const workflowRun =
    updated.entityType === "lead_workflow_run" && decision !== "handoff"
      ? await decideLeadWorkflowRun({
          session: auth.session,
          workflowRunId: updated.entityId,
          approvalId,
          decision,
        })
      : null;

  const conversationId = getConversationId(updated);
  const executedActions =
    decision === "approved"
      ? await executeApprovedBotActions({
          approvalId,
          conversationId,
          session: auth.session,
          toolCalls,
        })
      : {
          documentSendsCreated: 0,
          meetingBookingsCreated: 0,
          meetingProposalsPrepared: 0,
        };

  if (conversationId) {
    await insertBotMessage({
      session: auth.session,
      conversationId,
      content: getApprovalDecisionMessage(decision, language),
      metadata: {
        approvalDecision: decision,
        approvalId,
        executedActions,
        updatedToolCalls,
      },
      role: "system",
    });
  }

  if (decision === "handoff" && conversationId) {
    await queryOne(
      `
        update bot_conversations
        set status = 'handoff',
            updated_at = now()
        where id = $1 and workspace_id = $2
        returning id
      `,
      [conversationId, auth.session.workspaceId],
    );
  }

  await writeAuditLog({
    session: auth.session,
    action: `approval.${decision}`,
    entityType: updated.entityType,
    entityId: updated.entityId,
    after: {
      approvalId,
      conversationId,
      decision,
      toolCallIds,
      executedActions,
      updatedToolCalls,
      workflowRunId: workflowRun?.id ?? null,
    },
  });

  return Response.json({ approval: updated, conversationId, executedActions, updatedToolCalls, workflowRun });
}
