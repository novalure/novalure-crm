import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { getRolePermissions } from "../auth/permissions";
import { withCrmRead } from "../crm-command";
import type { ExternalIntegrationResolution } from "../db/external-integration-gateway";
import type { TenantTransaction, TenantTransactionOptions } from "../db/tenant-client";
import { resolveBotConversationContext } from "../db/runtime-repositories";
import { getProductRoleCapabilities } from "../product-model";
import { behaviorEnum, exactBehaviorObject, SharedBehaviorError, type LearningOutcome } from "./catalog";
import { loadSharedBehavior } from "./repository";
import { recordEvelynRuntimeSignal } from "./runtime";

export type NativeAssistantOptions = TenantTransactionOptions & {
  /** Explicit host-only test port, like pool/model. Never read from HTTP input. */
  nativeBehaviorEnv?: Readonly<Record<string, string | undefined>>;
  observeNativeBehavior?: (status: NativeRuntimeStatus) => void;
};
export type NativeSignalReceipt = Readonly<{ status: "disabled" | "not_configured" | "not_requested" | "recorded" | "unconfirmed"; replayed?: boolean }>;
export type NativeRuntimeStatus = Readonly<{ methodVersion: number | null; methodsCurrent: boolean; signal: NativeSignalReceipt }>;
const enabled = (key: string, options: NativeAssistantOptions) => {
  const env = options.nativeBehaviorEnv ?? process.env;
  return env.VERCEL_ENV === "production" && env[key] === "1";
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function deny(): never { throw new SharedBehaviorError("NATIVE_ASSISTANT_BINDING_DENIED"); }
export type NativeBehavior = Awaited<ReturnType<typeof loadSharedBehavior>>;
type Behavior = NativeBehavior;
type Scope = Readonly<{ workspaceId: string; projectId: string | null; botId: string }>;
export type NativeBotScope = Scope & { channel: string; conversationId?: string | null };
type SignalBinding = Scope & { integrationId: string | null; brokerActorId: string; actorId: string; capability: string };
const bindingKeys = ["workspaceId", "projectId", "botId", "integrationId", "brokerActorId", "actorId", "capability"] as const;

/** Server configuration only. No HTTP handler accepts this map or any member of it. */
function signalBindings(options: NativeAssistantOptions): readonly SignalBinding[] {
  const raw = (options.nativeBehaviorEnv ?? process.env).NOVALURE_SHARED_NATIVE_SIGNAL_BINDINGS;
  if (!raw || raw.length > 32_768) deny();
  let decoded: Record<string, unknown>;
  try { decoded = exactBehaviorObject(JSON.parse(raw), ["version", "bindings"]); } catch { deny(); }
  if (decoded.version !== 1 || !Array.isArray(decoded.bindings) || !decoded.bindings.length || decoded.bindings.length > 16) deny();
  const bots = new Set<string>(), actors = new Set<string>(), capabilities = new Set<string>();
  return decoded.bindings.map(value => {
    const row = exactBehaviorObject(value, bindingKeys);
    for (const key of ["workspaceId", "botId", "brokerActorId", "actorId"] as const) {
      if (typeof row[key] !== "string" || !uuid.test(row[key])) deny();
    }
    if (row.projectId !== null && (typeof row.projectId !== "string" || !uuid.test(row.projectId))) deny();
    if (row.integrationId !== null && (typeof row.integrationId !== "string" || !uuid.test(row.integrationId))) deny();
    if (row.actorId === row.brokerActorId || typeof row.capability !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(row.capability) || Buffer.from(row.capability, "base64url").length !== 32) deny();
    const botKey = `${row.workspaceId}:${row.botId}`, actorKey = `${row.workspaceId}:${row.actorId}`;
    if (bots.has(botKey) || actors.has(actorKey) || capabilities.has(row.capability)) deny();
    bots.add(botKey); actors.add(actorKey); capabilities.add(row.capability);
    return Object.freeze(row) as SignalBinding;
  });
}

/** The caller still reads knowledge and executes existing tools as itself. */
export async function loadNativeBotChatBehavior(session: AppSession, scope: NativeBotScope, options: NativeAssistantOptions = {}): Promise<Behavior | null> {
  if (!enabled("NOVALURE_SHARED_NATIVE_METHODS_ENABLED", options)) return null;
  if (["voice", "telephone"].includes(scope.channel)) return null;
  return withCrmRead(session, async (_tx, member) => {
    if (member.workspaceId !== scope.workspaceId) deny();
    const saved = await resolveBotConversationContext({ session: member, ...scope }, options);
    if (saved.projectId !== scope.projectId || !member.permissions.includes("bots:run")) deny();
    return loadSharedBehavior(member, "agent", options);
  }, options);
}

/** Invoke only inside the existing verified website authority transaction. */
export async function loadNativeWebsiteBehavior(session: AppSession, options: NativeAssistantOptions = {}): Promise<Behavior | null> {
  return enabled("NOVALURE_SHARED_NATIVE_METHODS_ENABLED", options) ? loadSharedBehavior(session, "webchat", options) : null;
}

/** Only reviewed catalog text reaches the model. Capabilities never enter this helper. */
export function appendNativeBehavior(system: string, behavior: Behavior | null): string {
  return behavior ? `${system}\n\nPublished shared behavior, method version ${behavior.version}:\n${behavior.instruction}` : system;
}

export function sameNativeBehavior(before: Behavior | null, after: Behavior | null): boolean {
  return before === null ? after === null : after !== null && before.version === after.version && before.instruction === after.instruction;
}

/** Pure format metric only. Text never reaches the signal repository. */
export function nativeNextStepOutcome(answer: string): LearningOutcome {
  return /(?:nächster schritt|next step|siguiente paso)\s*:/iu.test(answer) ? "pass" : "fail";
}

export function observeNativeBehavior(status: NativeRuntimeStatus, options: NativeAssistantOptions) {
  try { void Promise.resolve(options.observeNativeBehavior?.(Object.freeze(status))).catch(() => {}); }
  catch { /* A status observer cannot erase a business reply. */ }
}

/** Revalidate all sources exposed to the model, without consuming another query. */
export async function verifyNativeBotReply(session: AppSession, scope: NativeBotScope, before: Behavior | null,
  references: readonly { sourceId: string; versionId: string }[], options: NativeAssistantOptions = {}): Promise<boolean> {
  if (!enabled("NOVALURE_SHARED_NATIVE_METHODS_ENABLED", options) && !enabled("NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", options)) return before === null;
  if (["voice", "telephone"].includes(scope.channel)) return before === null;
  try {
    return await withCrmRead(session, async (tx, member) => {
      if (member.workspaceId !== scope.workspaceId || !member.permissions.includes("bots:run")) return false;
      const saved = await resolveBotConversationContext({ session: member, ...scope }, options);
      if (saved.projectId !== scope.projectId) return false;
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${member.workspaceId}`]);
      const entitled = await tx.queryOne<{ allowed: boolean }>(`select e.enabled and length(trim(coalesce(e.contract_reference,'')))>0
        and ($2<>'webchat' or e.features->>'webchatAccess'='true') and not exists(select 1 from workspace_module_settings m
          where m.workspace_id=e.workspace_id and m.module_key in ('knowledge','bots') and m.enabled=false) as allowed
        from knowledge_center_entitlements e where e.workspace_id=$1::uuid`, [member.workspaceId, scope.channel]);
      const refs = [...new Map(references.map(ref => [`${ref.sourceId}:${ref.versionId}`, ref])).values()];
      const valid = refs.length ? await tx.query(`select s.id from jsonb_to_recordset($1::jsonb) as r("sourceId" uuid,"versionId" uuid)
        join knowledge_sources s on s.id=r."sourceId" and s.approved_version_id=r."versionId" and s.workspace_id=$2::uuid and s.archived_at is null
        join knowledge_source_versions v on v.id=r."versionId" and v.source_id=s.id and v.workspace_id=s.workspace_id and v.status='approved'
        join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id and a.archived_at is null
        join knowledge_area_grants g on g.area_id=a.id and g.workspace_id=a.workspace_id and g.bot_id=$3::uuid and g.channel=$5
        where (a.project_id is null or a.project_id=$4::uuid) and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,false))
        `, [JSON.stringify(refs), member.workspaceId, scope.botId, scope.projectId, scope.channel]) : [];
      const current = await loadNativeBotChatBehavior(member, scope, options);
      return entitled?.allowed === true && valid.length === refs.length && sameNativeBehavior(before, current);
    }, options);
  } catch { return false; }
}

async function privateSignal(binding: SignalBinding, outcome: LearningOutcome, verify: (tx: TenantTransaction) => Promise<void>, options: NativeAssistantOptions): Promise<NativeSignalReceipt> {
  const broker: AppSession = { authenticated: true, source: "database", workspaceId: binding.workspaceId, userId: binding.brokerActorId,
    workspaceName: "Verified native workspace", name: "Verified native broker", email: "native-broker@service.invalid",
    role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") };
  const hash = createHash("sha256").update(binding.capability).digest("hex");
  const result = await recordEvelynRuntimeSignal(broker, binding.capability, { eventId: randomUUID(), issue: "unclear_next_step", outcome }, {
    ...options, statementTimeoutMs: 2000, verifyWorkload: async tx => {
      await verify(tx);
      const actual = await tx.queryOne<{ workspace_id: string; actor_id: string; bot_id: string }>(
        "select * from public.behavior_lock_runtime($1::uuid,$2)", [binding.brokerActorId, hash]);
      if (!actual || actual.workspace_id !== binding.workspaceId || actual.actor_id !== binding.actorId || actual.bot_id !== binding.botId) deny();
      // Existing resolver already holds this bot row's SHARE lock. SELECT
      // requires only exact-project read, never bot-edit rights for the actor.
      const bot = await tx.queryOne<{ projectId: string | null }>('select project_id as "projectId" from bots where id=$1::uuid and workspace_id=$2::uuid', [binding.botId, binding.workspaceId]);
      if (!bot || bot.projectId !== binding.projectId) deny();
    },
  });
  if (result.recorded !== true || typeof result.replayed !== "boolean") deny();
  return { status: "recorded", replayed: result.replayed };
}

/**
 * Narrow instrumentation: a fixed next-step-label format check, not semantic quality,
 * user satisfaction, a real handoff or a whole-conversation evaluation.
 * No message, visitor/session/conversation ID, excerpt or source ID is accepted.
 */
export async function recordNativeWebsiteFormat(input: Readonly<{
  expected: ExternalIntegrationResolution;
  origin: string;
  publicSiteKey: string;
  revalidateCompletedTurn: () => Promise<boolean>;
  outcome: LearningOutcome;
}>, options: NativeAssistantOptions = {}): Promise<NativeSignalReceipt> {
  if (!enabled("NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", options)) return { status: "disabled" };
  try {
    const expected = input.expected;
    const botId = expected.configuration.knowledgeAssistantId;
    if (typeof botId !== "string" || !uuid.test(botId)) deny();
    const binding = signalBindings(options).find(row => row.workspaceId === expected.workspaceId && row.projectId === expected.projectId &&
      row.botId === botId && row.integrationId === expected.integrationId && row.brokerActorId === expected.publicActorId);
    if (!binding) return { status: "not_configured" };
    if (!await input.revalidateCompletedTurn()) return { status: "unconfirmed" };
    return await privateSignal(binding, behaviorEnum(input.outcome, ["pass", "fail"] as const), async tx => {
        // Reuse the established native integration resolver and lock. It does
        // not retrieve customer knowledge or expose the private capability.
        const current = await tx.queryOne<ExternalIntegrationResolution>(`select integration_id as "integrationId",workspace_id as "workspaceId",
          project_id as "projectId",public_actor_id as "publicActorId",configuration,widget_configuration as "widgetConfiguration"
          from public.crm_external_integration_resolve($1,$2,'chat.context',null::uuid)`, [input.publicSiteKey, input.origin]);
        if (!current || current.workspaceId !== binding.workspaceId || current.integrationId !== binding.integrationId ||
          current.projectId !== binding.projectId || current.publicActorId !== binding.brokerActorId ||
          current.configuration.knowledgeAssistantId !== binding.botId || current.widgetConfiguration.chatEnabled !== true) throw new SharedBehaviorError("NATIVE_INTEGRATION_DENIED");
    }, options);
  } catch {
    // Optional private telemetry never weakens an answer guard or changes the
    // existing response. No raw configuration, credential or SQL error log.
    return { status: "unconfirmed" };
  }
}

/** Authenticated bot caller is checked as itself before the fixed private broker.
 * Knowledge, tools, persisted business actions and sessions never change actor. */
export async function recordNativeBotChatFormat(session: AppSession, scope: NativeBotScope, before: Behavior | null,
  references: readonly { sourceId: string; versionId: string }[], outcome: LearningOutcome, options: NativeAssistantOptions = {}): Promise<NativeSignalReceipt> {
  if (!enabled("NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", options) || ["voice", "telephone"].includes(scope.channel)) return { status: "disabled" };
  try {
    if (!await verifyNativeBotReply(session, scope, before, references, options)) return { status: "unconfirmed" };
    const binding = signalBindings(options).find(row => row.workspaceId === session.workspaceId && row.workspaceId === scope.workspaceId && row.botId === scope.botId && row.projectId === scope.projectId);
    if (!binding) return { status: "not_configured" };
    return await privateSignal(binding, behaviorEnum(outcome, ["pass", "fail"] as const), async () => {}, options);
  } catch { return { status: "unconfirmed" }; }
}
