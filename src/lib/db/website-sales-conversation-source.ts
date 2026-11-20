import type { AppSession } from "../auth/session";
import type { TenantTransaction } from "../crm-command";
import type { SalesConversationScope, SalesConversationSource } from "../website-sales-conversation-types";
import { websiteSalesIrelandState } from "./website-sales-ireland-repositories";

export type SalesConversationCanonicalSource = SalesConversationSource & { sourceUserId: string };
/** Internal metadata-only projection. The SQL function owns and limits private-text processing. */
export async function readSalesConversationSources(tx: TenantTransaction, session: AppSession, row: { projectId: string; id: string }, messageId: string | null = null, selectedLanguage = "en") {
  const values = await tx.query<SalesConversationCanonicalSource>(`select message_id as "messageId",source_user_id as "sourceUserId",received_at::text as "receivedAt",source_hash as "sourceHash",topic_code as "topicCode",language,basis,blocked_reason as "blockedReason",authorized,can_authorize as "canAuthorize"
    from crm_website_sales_topic_source($1,$2,$3,$4,$5)`, [session.workspaceId, row.projectId, row.id, messageId, selectedLanguage]);
  return values.map(value => ({ ...value, receivedAt: new Date(value.receivedAt).toISOString() }));
}
/** Used by pricing/portfolio only inside their freshly authorized tenant transaction. */
export async function readCurrentSalesConversationTopic(tx: TenantTransaction, session: AppSession, scope: SalesConversationScope, dialogSourceId: string) {
  const state = await websiteSalesIrelandState(tx, session, scope), workflow = state.current.workflow;
  if (!state.row || !workflow || workflow.qualificationStatus !== "READY" || workflow.blockedReason && workflow.blockedReason !== "REPLY_RECEIVED"
    || workflow.status === "STOPPED" && workflow.stopReason !== "REPLY_RECEIVED") return null;
  const turn = await tx.queryOne<{ id: string; messageId: string; sourceHash: string; language: string }>(`select id,message_id as "messageId",source_hash as "sourceHash",language from crm_website_sales_conversation_turns
    where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and(id=$6 or message_id=$6) and kind='TOPIC_RECORDED' and source_kind='CANONICAL_TOPIC_EXTRACTION' order by turn_index desc limit 1`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, state.row.id, dialogSourceId]);
  const source = (await readSalesConversationSources(tx, session, state.row, turn?.messageId ?? dialogSourceId, turn?.language ?? "en"))[0];
  if (!source?.authorized || turn && source.sourceHash !== turn.sourceHash || ["CONTACT_STOPPED", "SOURCE_CHANGED", "PURPOSE_PERMISSION_REQUIRED"].includes(source?.blockedReason ?? "")) return null;
  return { id: source.messageId, topicTurnId: turn?.id ?? null, messageId: source.messageId, topicCode: source.topicCode, language: source.language, sourceHash: source.sourceHash,
    sourceKind: "CANONICAL_TOPIC_EXTRACTION" as const, workflowVersion: workflow.version, evidenceDigest: workflow.evidenceDigest, canSend: false as const };
}
/** Fresh machine-read metadata, independent of the pricing repository and containing no body. */
export async function readSalesConversationDescriptor(tx: TenantTransaction, session: AppSession, scope: SalesConversationScope) {
  const state = await websiteSalesIrelandState(tx, session, scope); if (!state.row) return { version: 0, language: "en" as const };
  const saved = await tx.queryOne<{ version: number; language: "de" | "en" | null }>(`select c.version,(select t.language from crm_website_sales_conversation_turns t
    where t.workspace_id=c.workspace_id and t.conversation_id=c.id order by t.turn_index desc limit 1) as language
    from crm_website_sales_conversations c where c.workspace_id=$1 and c.project_id=$2 and c.company_id=$3 and c.location_id=$4 and c.workflow_id=$5`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, state.row.id]);
  return { version: saved?.version ?? 0, language: saved?.language ?? "en" as const };
}
