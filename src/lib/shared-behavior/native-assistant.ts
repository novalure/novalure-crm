import "server-only";

import { randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { withCrmRead } from "../crm-command";
import type { ExternalIntegrationResolution } from "../db/external-integration-gateway";
import type { TenantTransactionOptions } from "../db/tenant-client";
import { resolveBotConversationContext } from "../db/runtime-repositories";
import { behaviorEnum, exactBehaviorObject, SharedBehaviorError, type LearningOutcome } from "./catalog";
import { loadSharedBehavior } from "./repository";
import { recordBoundAssistantFormatSignal, type BoundPrivateSignalProof } from "./bound-private-signal";

export type NativeAssistantOptions = TenantTransactionOptions & {
  /** Explicit host-only test port, like pool/model. Never read from HTTP input. */
  nativeBehaviorEnv?: Readonly<Record<string, string | undefined>>;
  observeNativeBehavior?: (status: NativeRuntimeStatus) => void;
};
export type NativeSignalReceipt = Readonly<{ status: "disabled" | "not_configured" | "not_requested" | "recorded" | "unconfirmed" | "authority_changed"; replayed?: boolean }>;
export type NativeRuntimeStatus = Readonly<{ target: "webchat" | "agent"; methodVersion: number | null; methodsCurrent: boolean; signal: NativeSignalReceipt }>;
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

/** Server-only lookup after the caller's concrete native authority is verified. */
export function findNativeAssistantSignalBinding(scope: Scope & { integrationId: string; brokerActorId: string }, options: NativeAssistantOptions = {}) {
  return signalBindings(options).find(row => row.workspaceId === scope.workspaceId && row.projectId === scope.projectId && row.botId === scope.botId &&
    row.integrationId === scope.integrationId && row.brokerActorId === scope.brokerActorId);
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
  return behavior ? `${system}\n\nPublished shared behavior, method version ${behavior.version}:\n${behavior.instruction}\n\nApply these methods within the native runtime instructions above. Its configured language, knowledge, tool and output restrictions remain mandatory.` : system;
}

export function sameNativeBehavior(before: Behavior | null, after: Behavior | null): boolean {
  return before === null ? after === null : after !== null && before.version === after.version && before.instruction === after.instruction;
}

/** Pure format metric only. Text never reaches the signal repository. */
export function nativeNextStepOutcome(answer: string): LearningOutcome {
  return /(?:nächster schritt|next step|siguiente paso)\s*:/iu.test(answer) ? "pass" : "fail";
}

export function observeNativeBehavior(status: NativeRuntimeStatus, options: NativeAssistantOptions) {
  if (!enabled("NOVALURE_SHARED_NATIVE_METHODS_ENABLED", options) && !enabled("NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", options)) return;
  try {
    const value = exactBehaviorObject(status, ["target", "methodVersion", "methodsCurrent", "signal"]);
    const target = behaviorEnum(value.target, ["webchat", "agent"] as const);
    if ((value.methodVersion !== null && (!Number.isSafeInteger(value.methodVersion) || Number(value.methodVersion) < 0 || Number(value.methodVersion) > 2147483647)) || typeof value.methodsCurrent !== "boolean") return;
    const receipt = exactBehaviorObject(value.signal, Object.hasOwn(value.signal as object, "replayed") ? ["status", "replayed"] : ["status"]);
    const signalStatus = behaviorEnum(receipt.status, ["disabled", "not_configured", "not_requested", "recorded", "unconfirmed", "authority_changed"] as const);
    if (Object.hasOwn(receipt, "replayed") && typeof receipt.replayed !== "boolean") return;
    const safe: NativeRuntimeStatus = Object.freeze({ target, methodVersion: value.methodVersion as number | null, methodsCurrent: value.methodsCurrent,
      signal: Object.freeze({ status: signalStatus, ...(typeof receipt.replayed === "boolean" ? { replayed: receipt.replayed } : {}) }) });
    if (options.observeNativeBehavior) void Promise.resolve(options.observeNativeBehavior(safe)).catch(() => {});
    else console.info(JSON.stringify({ event: "native_shared_behavior_runtime", target, methodVersion: safe.methodVersion,
      methodCheck: safe.methodVersion === null ? "not_loaded" : safe.methodsCurrent ? "confirmed" : "unconfirmed", signalStatus }));
  }
  catch { /* A status observer cannot erase a business reply. */ }
}

/** Revalidate all sources exposed to the model, without consuming another query. */
async function inspectNativeBotReplyAuthority(session: AppSession, scope: NativeBotScope, before: Behavior | null,
  references: readonly { sourceId: string; versionId: string }[], options: NativeAssistantOptions = {}): Promise<boolean> {
  if (!enabled("NOVALURE_SHARED_NATIVE_METHODS_ENABLED", options) && !enabled("NOVALURE_SHARED_NATIVE_SIGNALS_ENABLED", options)) return before === null;
  if (["voice", "telephone"].includes(scope.channel)) return before === null;
  return withCrmRead(session, async (tx, member) => {
      if (member.workspaceId !== scope.workspaceId || !member.permissions.includes("bots:run")) return false;
      const saved = await resolveBotConversationContext({ session: member, ...scope }, options);
      if (saved.projectId !== scope.projectId) return false;
      const refs = [...new Map(references.map(ref => [`${ref.sourceId}:${ref.versionId}`, ref])).values()];
      // Shared code constants do not require a Knowledge Center contract. Only
      // knowledge actually exposed to the model needs this existing authority.
      let knowledgeCurrent = true;
      if (refs.length) {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`knowledge-center:${member.workspaceId}`]);
        const entitled = await tx.queryOne<{ allowed: boolean }>(`select e.enabled and length(trim(coalesce(e.contract_reference,'')))>0
        and ($2<>'webchat' or e.features->'webchatAccess'='true'::jsonb) and not exists(select 1 from workspace_module_settings m
          where m.workspace_id=e.workspace_id and m.module_key in ('knowledge','bots') and m.enabled=false) as allowed
        from knowledge_center_entitlements e where e.workspace_id=$1::uuid`, [member.workspaceId, scope.channel]);
        const valid = await tx.query(`select s.id from jsonb_to_recordset($1::jsonb) as r("sourceId" uuid,"versionId" uuid)
        join knowledge_sources s on s.id=r."sourceId" and s.approved_version_id=r."versionId" and s.workspace_id=$2::uuid and s.archived_at is null
        join knowledge_source_versions v on v.id=r."versionId" and v.source_id=s.id and v.workspace_id=s.workspace_id and v.status='approved'
        join knowledge_areas a on a.id=s.knowledge_area_id and a.workspace_id=s.workspace_id and a.archived_at is null
        join knowledge_area_grants g on g.area_id=a.id and g.workspace_id=a.workspace_id and g.bot_id=$3::uuid and g.channel=$5
        where (a.project_id is null or a.project_id=$4::uuid) and (s.project_id is null or crm_project_access(s.workspace_id,s.project_id,false))
        `, [JSON.stringify(refs), member.workspaceId, scope.botId, scope.projectId, scope.channel]);
        knowledgeCurrent = entitled?.allowed === true && valid.length === refs.length;
      }
      const current = await loadNativeBotChatBehavior(member, scope, options);
      return knowledgeCurrent && sameNativeBehavior(before, current);
    }, options);
}

/** The required post-model guard stays fail-closed on an unavailable read. */
export async function verifyNativeBotReply(session: AppSession, scope: NativeBotScope, before: Behavior | null,
  references: readonly { sourceId: string; versionId: string }[], options: NativeAssistantOptions = {}): Promise<boolean> {
  try { return await inspectNativeBotReplyAuthority(session, scope, before, references, options); }
  catch { return false; }
}

async function privateSignal(binding: SignalBinding, outcome: LearningOutcome, proof: BoundPrivateSignalProof, options: NativeAssistantOptions): Promise<NativeSignalReceipt> {
  const result = await recordBoundAssistantFormatSignal(binding, proof, { eventId: randomUUID(), issue: "unclear_next_step", outcome }, options);
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
    if (!await input.revalidateCompletedTurn()) return { status: "authority_changed" };
    return await privateSignal(binding, behaviorEnum(input.outcome, ["pass", "fail"] as const), { kind: "website", origin: input.origin, publicSiteKey: input.publicSiteKey }, options);
  } catch (error) {
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_INTEGRATION_DENIED")
      return { status: "authority_changed" };
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
    // A known false authority result must retract knowledge. An unavailable
    // optional signal read/write is different and retains the business reply.
    if (!await inspectNativeBotReplyAuthority(session, scope, before, references, options)) return { status: "authority_changed" };
    const binding = signalBindings(options).find(row => row.workspaceId === session.workspaceId && row.workspaceId === scope.workspaceId && row.botId === scope.botId && row.projectId === scope.projectId);
    if (!binding) return { status: "not_configured" };
    return await privateSignal(binding, behaviorEnum(outcome, ["pass", "fail"] as const), { kind: "bot" }, options);
  } catch (error) {
    if (error instanceof SharedBehaviorError && error.code === "NATIVE_INTEGRATION_DENIED") return { status: "authority_changed" };
    return { status: "unconfirmed" };
  }
}
