import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "../auth/session";
import { assertProjectGrant, crmPayloadDigest, withCrmRead } from "../crm-command";
import type { ExternalIntegrationResolution } from "../db/external-integration-gateway";
import { withTenantTransaction, type TenantTransaction, type TenantTransactionOptions } from "../db/tenant-client";
import { SharedBehaviorError } from "./catalog";
import { insertPrivateSignal, parsePrivateSignal } from "./private-signal-insert";

export type BoundPrivateSignalScope = Readonly<{ workspaceId: string; projectId: string | null; botId: string;
  integrationId: string | null; brokerActorId: string; actorId: string; capability: string }>;
export type BoundPrivateSignalProof = Readonly<{ kind: "bot" }> | Readonly<{ kind: "website"; origin: string; publicSiteKey: string }>;
type Binding = { id: string; workspace_id: string; actor_id: string; bot_id: string; department: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
let activeSignals = 0;
function denied(): never { throw new SharedBehaviorError("NATIVE_SIGNAL_ACCESS_DENIED"); }
function changed(): never { throw new SharedBehaviorError("NATIVE_INTEGRATION_DENIED"); }
const lock = (tx: TenantTransaction, scope: BoundPrivateSignalScope, hash: string) =>
  tx.queryOne<Binding>("select * from public.behavior_lock_runtime($1::uuid,$2)", [scope.brokerActorId, hash]);
function exactBinding(row: Binding | null, scope: BoundPrivateSignalScope): row is Binding {
  return !!row && row.workspace_id === scope.workspaceId && row.actor_id === scope.actorId && row.bot_id === scope.botId;
}

/** Fixed format-event write only. Broker authority never becomes private actor
 * authority; no session, generic transaction callback or knowledge is returned. */
export async function recordBoundAssistantFormatSignal(scope: BoundPrivateSignalScope, proof: BoundPrivateSignalProof,
  value: unknown, options: TenantTransactionOptions = {}) {
  const input = parsePrivateSignal(value);
  if (input.issue !== "unclear_next_step" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(input.eventId)) denied();
  if ([scope.workspaceId, scope.botId, scope.brokerActorId, scope.actorId].some(id => !uuid.test(id)) ||
    scope.actorId === scope.brokerActorId || scope.projectId !== null && !uuid.test(scope.projectId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(scope.capability) || Buffer.from(scope.capability, "base64url").length !== 32) denied();
  // At most two nested broker/private operations per process. No waiting queue
  // or retry. Both checkouts also have a bounded wait and release late clients.
  if (activeSignals >= 2) throw new SharedBehaviorError("NATIVE_SIGNAL_BUSY");
  activeSignals++;
  try {
    const budget = { ...options, statementTimeoutMs: 1500, poolAcquireTimeoutMs: 500 };
    const hash = createHash("sha256").update(scope.capability).digest("hex");
    const broker: AppSession = { authenticated: true, source: "database", workspaceId: scope.workspaceId, userId: scope.brokerActorId,
      workspaceName: "Verified signal broker", name: "Verified signal broker", email: "signal-broker@service.invalid",
      role: "agent", productRole: "project_sales_member", permissions: [], productPermissions: [] };
    return await withCrmRead(broker, async (outer, member) => {
      // Normal currentMember/classification remain mandatory for the broker.
      if (proof.kind === "website") {
        const current = await outer.queryOne<ExternalIntegrationResolution>(`select integration_id as "integrationId",workspace_id as "workspaceId",
          project_id as "projectId",public_actor_id as "publicActorId",configuration,widget_configuration as "widgetConfiguration"
          from public.crm_external_integration_resolve($1,$2,'chat.context',null::uuid)`, [proof.publicSiteKey, proof.origin]);
        if (!current || current.integrationId !== scope.integrationId || current.workspaceId !== scope.workspaceId ||
          current.projectId !== scope.projectId || current.publicActorId !== member.userId ||
          current.configuration.knowledgeAssistantId !== scope.botId || current.widgetConfiguration.chatEnabled !== true) changed();
      } else if (proof.kind !== "bot") denied();
      const bound = await lock(outer, scope, hash);
      if (!exactBinding(bound, scope)) denied();
      // 117 already holds SHARE on binding, broker, private actor and bot.
      // The broker reads bot/project metadata; the private actor never does.
      const bot = await outer.queryOne<{ projectId: string | null }>('select project_id as "projectId" from bots where id=$1::uuid and workspace_id=$2::uuid', [scope.botId, scope.workspaceId]);
      if (!bot || bot.projectId !== scope.projectId) changed();
      if (scope.projectId) await assertProjectGrant(outer, member, scope.projectId);
      if (await outer.queryOne("select 1 from knowledge_area_grants where workspace_id=$1::uuid and bot_id=$2::uuid and channel='internal' limit 1", [scope.workspaceId, scope.botId])) denied();
      // Explicit private tx, independent of the broker's AsyncLocal context.
      // It deliberately cannot call generic withCrmRead or acquire internal
      // business classification; project_sales_member keeps those RLS denies.
      return withTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, async inner => {
        const fresh = await lock(inner, scope, hash);
        if (!exactBinding(fresh, scope) || crmPayloadDigest(fresh) !== crmPayloadDigest(bound)) denied();
        const actor = await inner.queryOne<{ role: string; productRole: string; authIdentityId: string | null }>(
          'select role,product_role as "productRole",auth_identity_id as "authIdentityId" from crm_lock_active_member($1::uuid,$2::uuid)', [scope.workspaceId, scope.actorId]);
        if (!actor || actor.role !== "agent" || actor.productRole !== "project_sales_member" || !actor.authIdentityId) denied();
        const auth = await inner.queryOne<{ disabled: boolean; noPassword: boolean }>(`select credential_state='disabled' and disabled_at is not null as disabled,
          password_hash is null as "noPassword" from auth_identities where id=$1::uuid for share`, [actor.authIdentityId]);
        const closed = await inner.queryOne<{ closed: boolean }>(`select
          not crm_workspace_manager($1::uuid)
          and not exists(select 1 from project_pipeline_permissions where workspace_id=$1::uuid and user_id=$2::uuid)
          and not exists(select 1 from auth_sessions where auth_identity_id=$3::uuid)
          and not exists(select 1 from auth_login_challenges where auth_identity_id=$3::uuid)
          and exists(select 1 from workspace_users where workspace_id=$1::uuid and id=$2::uuid and password_hash is null) as closed`, [scope.workspaceId, scope.actorId, actor.authIdentityId]);
        if (!auth?.disabled || !auth.noPassword || closed?.closed !== true) denied();
        if (!exactBinding(await lock(inner, scope, hash), scope)) denied();
        const receipt = await insertPrivateSignal(inner, scope.workspaceId, scope.actorId, input);
        // Refresh the existing expiry/revoke fence immediately before COMMIT.
        if (!exactBinding(await lock(inner, scope, hash), scope)) denied();
        return receipt;
      }, budget);
      // Outer resolver/member/bot/binding locks outlive the private COMMIT.
    }, budget);
  } finally { activeSignals--; }
}
