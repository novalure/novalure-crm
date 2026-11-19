import "server-only";

import { createHash } from "node:crypto";
import type { AppSession } from "../auth/session";
import { withCrmRead } from "../crm-command";
import { ExternalIntegrationError, type ExternalIntegrationResolution } from "../db/external-integration-gateway";
import type { TenantTransaction, TenantTransactionOptions } from "../db/tenant-client";
import { readWebchatUsage, reserveWebchatUsage, settleWebchatUsage } from "./quota";

export type CustomerTurnInput = {
  origin: string; publicSiteKey: string; sessionId: string; sessionToken: string; message: string; requestId?: string;
};
type Turn = { requestId: string; botId: string; response: string | null; replayed: boolean };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function actor(resolution: ExternalIntegrationResolution): AppSession {
  // withCrmRead replaces these hints with the current persisted membership.
  return { authenticated: true, source: "database", userId: resolution.publicActorId, workspaceId: resolution.workspaceId,
    workspaceName: "Verified integration", name: "Verified integration", email: "integration@service.invalid",
    role: "owner", productRole: "customer_owner", permissions: ["crm:read"], productPermissions: [] };
}

async function lockVisitor(tx: TenantTransaction, input: CustomerTurnInput, expected: ExternalIntegrationResolution) {
  const current = await tx.queryOne<ExternalIntegrationResolution>(`select integration_id as "integrationId",workspace_id as "workspaceId",
    project_id as "projectId",public_actor_id as "publicActorId",configuration,integration_mode as "integrationMode"
    from public.crm_external_integration_resolve($1,$2,'chat.context',null::uuid)`, [input.publicSiteKey, input.origin]);
  if (!current || current.integrationId !== expected.integrationId || current.workspaceId !== expected.workspaceId ||
    current.publicActorId !== expected.publicActorId || current.projectId !== expected.projectId ||
    current.configuration.knowledgeAssistantId !== expected.configuration.knowledgeAssistantId) throw new ExternalIntegrationError("integration_not_found", 404);
  const visitor = await tx.queryOne<{ synthetic: boolean; mode: string }>(`select synthetic,mode from external_chat_sessions
    where id=$1::uuid and workspace_id=$2::uuid and integration_id=$3::uuid and project_id is not distinct from $4::uuid
      and session_token_hash=$5 and status='active' for update`,
  [input.sessionId, current.workspaceId, current.integrationId, current.projectId, digest(input.sessionToken)]);
  if (!visitor) throw new ExternalIntegrationError("session_denied", 403);
  if (process.env.NOVALURE_WEBCHAT_PRODUCT_ISOLATED_ENABLED !== "1" || process.env.VERCEL_ENV === "production" || current.integrationMode !== "training" ||
    visitor.mode !== "training" || !visitor.synthetic) throw new ExternalIntegrationError("customer_product_not_activated", 403);
  return current;
}

/** A configured customer account cannot fall back to the unmetered legacy path. */
export async function beginCustomerTurn(input: CustomerTurnInput, expected: ExternalIntegrationResolution, options: TenantTransactionOptions): Promise<Turn | null> {
  return withCrmRead(actor(expected), async tx => {
    if (!await readWebchatUsage(tx, expected.workspaceId)) return null;
    const current = await lockVisitor(tx, input, expected);
    if (!input.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)) {
      throw new ExternalIntegrationError("answer_request_id_required", 400);
    }
    const botId = String(current.configuration.knowledgeAssistantId);
    const reservation = await reserveWebchatUsage(tx, { workspaceId: current.workspaceId, botId, requestId: input.requestId, units: 1,
      requestDigest: digest(JSON.stringify([current.integrationId, input.sessionId, botId, input.message])) });
    if (!reservation) throw new ExternalIntegrationError("customer_product_unavailable", 503);
    if (reservation.replayed && (reservation.state === "reserved" || !reservation.response)) throw new ExternalIntegrationError("answer_outcome_pending", 409);
    return { requestId: input.requestId, botId, response: reservation.response ?? null, replayed: reservation.replayed };
  }, options);
}

export async function completeCustomerTurn(input: CustomerTurnInput, expected: ExternalIntegrationResolution, turn: Turn,
  response: string, consumed: boolean, options: TenantTransactionOptions, revalidate: () => Promise<void>) {
  return withCrmRead(actor(expected), async tx => {
    await lockVisitor(tx, input, expected);
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${expected.workspaceId}`]);
    const access = await tx.queryOne<{ allowed: boolean }>("select public.webchat_lock_answer_access($1::uuid) as allowed", [expected.workspaceId]);
    if (!access?.allowed) throw new ExternalIntegrationError("answer_authority_changed", 403);
    // This callback shares this transaction through withCrmRead's bound context.
    // Knowledge/entitlement locks remain held through messages+receipt COMMIT.
    await revalidate();
    // The receipt, both visitor-visible messages, summary and quota commit together.
    await settleWebchatUsage(tx, { workspaceId: expected.workspaceId, botId: turn.botId, requestId: turn.requestId,
      outcome: consumed ? "consumed" : "released", response });
    const { answer } = JSON.parse(response) as { answer: { answer: string } };
    for (const [role, content] of [["visitor", input.message], ["assistant", answer.answer]]) {
      await tx.query(`insert into external_chat_messages(session_id,integration_id,workspace_id,role,content,idempotency_hash,synthetic,created_at)
        values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,true,clock_timestamp()) on conflict(session_id,idempotency_hash) do nothing`,
      [input.sessionId, expected.integrationId, expected.workspaceId, role, content, digest(`${input.sessionId}:${turn.requestId}:${role}`)]);
    }
    await tx.query(`update external_chat_sessions set metadata=jsonb_set(metadata,'{webchatSummary}',$4::jsonb),updated_at=now()
      where id=$1::uuid and workspace_id=$2::uuid and integration_id=$3::uuid`,
    [input.sessionId, expected.workspaceId, expected.integrationId, JSON.stringify({ kind: "extractive", text: input.message.slice(0, 500) })]);
  }, options);
}

/** Known pre-provider failure releases capacity; unknown effects remain reserved. */
export async function releaseUnstartedCustomerTurn(input: CustomerTurnInput, expected: ExternalIntegrationResolution, turn: Turn, options: TenantTransactionOptions) {
  return withCrmRead(actor(expected), async tx => {
    await lockVisitor(tx, input, expected);
    await settleWebchatUsage(tx, { workspaceId: expected.workspaceId, botId: turn.botId, requestId: turn.requestId, outcome: "released" });
  }, options);
}
