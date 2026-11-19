import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import { listManagedWebsiteIntegrations } from "@/lib/integrations/website-integration-management";
import { hasProductCapability } from "@/lib/product-model";
import { readWebchatUsage } from "@/lib/webchat-product/quota";

export type WebchatPortalMessage = { id: string; role: string; content: string; createdAt: string };
export type WebchatMessageCursor = { createdAt: string; id: string };
export type WebchatConversationCursor = { updatedAt: string; id: string };
export type WebchatPortalConversation = {
  id: string; integrationId: string; projectId: string | null; language: string;
  status: string; synthetic: boolean; updatedAt: string; summary: string;
  summaryKind: "extractive" | "preview"; messages: WebchatPortalMessage[];
  hasOlderMessages: boolean; messageCursor: WebchatMessageCursor | null;
};
type SessionRow = Omit<WebchatPortalConversation, "summary" | "summaryKind" | "hasOlderMessages" | "messageCursor"> & { savedSummary: unknown };

function cursorTime(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CrmCommandError("VALIDATION_ERROR", "Ungültige Verlaufsseite.");
  }
  // Keep database microseconds intact: Date.toISOString would lose rows.
  return value;
}

/** Paged customer transcript; system/technical messages are never projected. */
export async function readWebchatConversationMessages(session: AppSession, input: { conversationId: string; cursor?: WebchatMessageCursor }, options: TenantTransactionOptions = {}) {
  assertCrmUuid(input.conversationId, "conversationId");
  if (input.cursor) { cursorTime(input.cursor.createdAt); assertCrmUuid(input.cursor.id, "message cursor"); }
  return withCrmRead(session, async (tx, member) => {
    if (member.serviceIdentity || !hasProductCapability(member.productRole, "workspace:read")) throw new CrmCommandError("FORBIDDEN", "Kundenbereich erfordert einen berechtigten Benutzer.", 403);
    const conversation = await tx.queryOne<{ id: string }>(`select s.id from external_chat_sessions s where s.workspace_id=$1::uuid and s.id=$2::uuid
      and (s.project_id is null and crm_workspace_manager(s.workspace_id) or s.project_id is not null and crm_project_access(s.workspace_id,s.project_id,false))`, [member.workspaceId, input.conversationId]);
    if (!conversation) throw new CrmCommandError("NOT_FOUND", "Gespräch nicht gefunden.", 404);
    const rows = await tx.query<WebchatPortalMessage>(`select m.id,m.role,m.content,m.created_at::text as "createdAt" from external_chat_messages m
      where m.workspace_id=$1::uuid and m.session_id=$2::uuid and m.role in ('visitor','assistant')
        and ($3::timestamptz is null or (m.created_at,m.id)<($3::timestamptz,$4::uuid))
      order by m.created_at desc,m.id desc limit 31`, [member.workspaceId, input.conversationId, input.cursor?.createdAt ?? null, input.cursor?.id ?? null]);
    const messages = rows.slice(0, 30).reverse();
    return { conversationId: input.conversationId, messages, hasOlder: rows.length > 30,
      nextCursor: messages.length ? { createdAt: messages[0].createdAt, id: messages[0].id } : null };
  }, options);
}

/** Bounded read projection. Original messages remain the authoritative record. */
export function webchatConversationSummary(saved: unknown, messages: readonly WebchatPortalMessage[]) {
  if (saved && typeof saved === "object" && "kind" in saved && saved.kind === "extractive"
    && "text" in saved && typeof saved.text === "string" && saved.text.trim()) {
    return { summary: saved.text.slice(0, 1200), summaryKind: "extractive" as const };
  }
  return { summary: messages.filter(message => message.role === "visitor").map(message => message.content.trim()).filter(Boolean).slice(-3).join(" · ").slice(0, 1200), summaryKind: "preview" as const };
}

/** Every projection is scoped by fresh membership, tenant RLS and project access. */
export async function readWebchatCustomerPortal(session: AppSession, options: TenantTransactionOptions = {}, cursor?: WebchatConversationCursor) {
  if (cursor) { cursorTime(cursor.updatedAt); assertCrmUuid(cursor.id, "conversation cursor"); }
  return withCrmRead(session, async (tx, member) => {
    if (member.serviceIdentity || !hasProductCapability(member.productRole, "workspace:read")) {
      throw new CrmCommandError("FORBIDDEN", "Der Kundenbereich erfordert einen berechtigten Benutzer.", 403);
    }
    const canManage = member.permissions.includes("crm:write") && hasProductCapability(member.productRole, "settings:manage")
      && hasProductCapability(member.productRole, "bots:publish");
    const bots = await tx.query<{ id: string; name: string; projectId: string | null }>(`select id,name,project_id as "projectId" from bots
      where workspace_id=$1::uuid and (project_id is null or crm_project_access(workspace_id,project_id,false)) order by name,id`, [member.workspaceId]);
    const sessions = await tx.query<SessionRow>(`select s.id,s.integration_id as "integrationId",s.project_id as "projectId",s.language,s.status,s.synthetic,
      s.updated_at::text as "updatedAt",to_jsonb(s)->'metadata'->'webchatSummary' as "savedSummary",
      coalesce((select jsonb_agg(to_jsonb(recent) order by recent."createdAt",recent.id) from
        (select m.id,m.role,m.content,m.created_at::text as "createdAt" from external_chat_messages m
          where m.workspace_id=s.workspace_id and m.session_id=s.id and m.integration_id=s.integration_id and m.role in ('visitor','assistant')
          order by m.created_at desc,m.id desc limit 31) recent),'[]'::jsonb) as messages
      from external_chat_sessions s where s.workspace_id=$1::uuid
        and (s.project_id is null and crm_workspace_manager(s.workspace_id) or s.project_id is not null and crm_project_access(s.workspace_id,s.project_id,false))
        and ($2::timestamptz is null or (s.updated_at,s.id)<($2::timestamptz,$3::uuid))
      order by s.updated_at desc,s.id desc limit 51`, [member.workspaceId, cursor?.updatedAt ?? null, cursor?.id ?? null]);
    const conversations: WebchatPortalConversation[] = sessions.slice(0, 50).map(({ savedSummary, ...row }) => {
      const messages = row.messages.slice(-30);
      return { ...row, messages, ...webchatConversationSummary(savedSummary, messages), hasOlderMessages: row.messages.length > 30,
        messageCursor: messages.length ? { createdAt: messages[0].createdAt, id: messages[0].id } : null };
    });
    const leads = await tx.query<{ id: string; name: string; status: string; source: string; projectId: string | null; receivedAt: string }>(`select l.id,
      coalesce(c.name,nullif(l.intent,''),l.type) as name,l.status,l.source,l.project_id as "projectId",l.received_at::text as "receivedAt"
      from leads l left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id
      where l.workspace_id=$1::uuid and (l.project_id is null or crm_project_access(l.workspace_id,l.project_id,false))
        and (l.source ilike '%web%' or l.source ilike '%chat%' or l.source ilike '%studio%' or l.metadata ? 'externalIntegrationId')
      order by l.received_at desc,l.id limit 50`, [member.workspaceId]);
    const knowledge = await tx.queryOne<{ publishedSources: number; assignedAssistants: number }>(`select
      (select count(*)::int from knowledge_sources s where s.workspace_id=$1::uuid and s.archived_at is null and s.approved_version_id is not null
        and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,false))) as "publishedSources",
      (select count(distinct g.bot_id)::int from knowledge_area_grants g join bots b on b.id=g.bot_id and b.workspace_id=g.workspace_id
        where g.workspace_id=$1::uuid and g.channel='webchat' and (b.project_id is null or crm_project_access(b.workspace_id,b.project_id,false))) as "assignedAssistants"`, [member.workspaceId]);
    const website = canManage ? await listManagedWebsiteIntegrations(member, options) : null;
    const team = canManage ? await tx.query<{ id: string; name: string; email: string; productRole: string; status: string }>(`select id,name,email,product_role as "productRole",status
      from workspace_users where workspace_id=$1::uuid order by name,id limit 200`, [member.workspaceId]) : [];
    const usage = await readWebchatUsage(tx, member.workspaceId);
    return {
      workspace: { id: member.workspaceId, name: member.workspaceName }, permissions: { canManage },
      setup: { website: Boolean(website?.integrations.length), knowledge: (knowledge?.publishedSources ?? 0) > 0,
        assistant: (knowledge?.assignedAssistants ?? 0) > 0,
        embedding: website?.integrations.some(row => row.readiness.ready && row.status === "test" && row.mode === "training") ?? false },
      integrations: website?.integrations ?? [], bots, conversations, leads, team,
      usage: usage ? { ...usage, contractReference: canManage ? usage.contractReference : "", offers: canManage ? usage.offers : [], orders: canManage ? usage.orders : [], bots: usage.bots.filter(item => bots.some(bot => bot.id === item.botId)) } : null,
      displayLimits: { conversations: 50, messagesPerConversation: 30, leads: 50 },
      conversationPage: { hasOlder: sessions.length > 50, nextCursor: conversations.length ? { updatedAt: conversations[conversations.length - 1].updatedAt, id: conversations[conversations.length - 1].id } : null },
    };
  }, options);
}

export type WebchatCustomerPortalSnapshot = Awaited<ReturnType<typeof readWebchatCustomerPortal>>;
