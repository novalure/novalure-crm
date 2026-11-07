import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "../auth/session";
import { getRolePermissions } from "../auth/permissions";
import { getProductRoleCapabilities } from "../product-model";
import { crmPayloadDigest, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { retrieveKnowledgeForSavedChannel } from "../knowledge-center/integrations";
import { knowledgeText, KnowledgeCenterError } from "../knowledge-center/policy";
import { exactBehaviorObject } from "./catalog";
import { loadSharedBehavior, recordPrivateLearningSignal } from "./repository";

export const evelynDepartments = Object.freeze(["executive","sales","marketing","buyer","support","finance","engineering","security","legal","qc","procurement","hr","personal"] as const);
export type RuntimeOptions = TenantTransactionOptions & { verifyWorkload?: (tx: TenantTransaction) => Promise<void> };
type Binding = { id: string; workspace_id: string; actor_id: string; bot_id: string; department: typeof evelynDepartments[number] };
function deny(): never { throw new KnowledgeCenterError("RUNTIME_ACCESS_DENIED", "Runtime access is not granted.", 403); }
function tokenHash(capability: unknown) {
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(capability)) deny();
  return createHash("sha256").update(capability).digest("hex");
}
async function withRuntime<T>(broker: AppSession, capability: unknown, work: (session: AppSession, binding: Binding) => Promise<T>, options: RuntimeOptions) {
  const hash = tokenHash(capability);
  // The common workload does not choose its actor/department/bot in model input.
  const binding = await withCrmRead(broker, async tx => {
    const row = await tx.queryOne<Binding>("select * from public.behavior_lock_runtime($1::uuid,$2)", [broker.userId, hash]);
    if (!row || row.workspace_id !== broker.workspaceId || !evelynDepartments.includes(row.department)) deny();
    return row;
  }, options);
  const runtime: AppSession = { authenticated: true, source: "database", workspaceId: binding.workspace_id,
    userId: binding.actor_id, workspaceName: "Verified runtime workspace", name: "Verified Evelyn runtime", email: "runtime@service.invalid",
    role: "agent", productRole: "project_sales_member", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("project_sales_member") };
  return withCrmRead(runtime, async (tx, member) => {
    const current = await tx.queryOne<Binding>("select * from public.behavior_lock_runtime($1::uuid,$2)", [broker.userId, hash]);
    if (!current || crmPayloadDigest(current) !== crmPayloadDigest(binding)) deny();
    await options.verifyWorkload?.(tx);
    // Resolver row locks and currentMember locks remain held through retrieval.
    return work(member, current);
  }, options);
}
export async function loadEvelynRuntimeContext(broker: AppSession, capability: unknown, value: unknown, options: RuntimeOptions = {}) {
  const input = exactBehaviorObject(value, ["query"]);
  const query = knowledgeText(input.query, "query", 2000);
  return withRuntime(broker, capability, async (session, binding) => {
    const behavior = await loadSharedBehavior(session, binding.department === "executive" ? "ceo" : "department", options);
    const knowledge = await retrieveKnowledgeForSavedChannel(session, { assistantId: binding.bot_id, channel: "internal", query, maxResults: 5 }, options);
    return { contractVersion: "evelyn-runtime-context-v1", department: binding.department,
      behavior, knowledge: { grounded: knowledge.grounded, excerpts: knowledge.matches.map(m => ({ sourceId: m.sourceId, versionId: m.versionId, text: m.excerpt, trust: "retrieved_knowledge_data" })) },
      toolsGranted: [] };
  }, options);
}
export async function recordEvelynRuntimeSignal(broker: AppSession, capability: unknown, value: unknown, options: RuntimeOptions = {}) {
  return withRuntime(broker, capability, session => recordPrivateLearningSignal(session, value, options), options);
}
