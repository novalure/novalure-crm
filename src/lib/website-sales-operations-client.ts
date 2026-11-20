"use client";
import { csrfFetch } from "./security/csrf-client";
import { assertSalesWriteBarrier } from "./website-sales-write-barrier";
import { websiteSalesOperationsContract, websiteSalesOperationsPath, type SalesOperationsCommand, type SalesOperationsRead } from "./website-sales-operations-types";
import { websiteSalesConversationContract, websiteSalesConversationPath, type SalesConversationCommand, type SalesConversationRead, type SalesConversationScope } from "./website-sales-conversation-types";

export type SalesOperationsArea = "autonomy" | "conversation";
type Command = SalesOperationsCommand | SalesConversationCommand;
export type SalesOperationsPending = { area: SalesOperationsArea; body: string; command: Command; state: "IN_FLIGHT" | "UNKNOWN"; currentRead: boolean; retryAllowed: boolean; damaged?: true };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, sha = /^[a-f0-9]{64}$/;
const settings = {
  autonomy: { contract: websiteSalesOperationsContract, path: websiteSalesOperationsPath, prefix: "novalure.website-sales-operations.pending.v1", operations: ["configure_portfolio", "plan_portfolio", "claim_allocation", "settle_allocation", "register_price_rule", "propose_price", "apply_quote", "register_financial_evidence", "record_outcome", "propose_improvement", "review_improvement", "promote_improvement"] },
  conversation: { contract: websiteSalesConversationContract, path: websiteSalesConversationPath, prefix: "novalure.website-sales-conversation.pending.v1", operations: ["authorize_topic_extraction", "record_answer_fact", "record_topic", "draft_answer", "advance_conversation", "stop_conversation"] },
} as const;
const pending = new Map<string, SalesOperationsPending>(), listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export function subscribeSalesOperationsPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("INVALID_SALES_OPERATIONS_RESPONSE"); return raw as Record<string, unknown>; }
function storageKey(area: SalesOperationsArea, workspaceId: string, actorId: string) {
  if (!uuid.test(workspaceId) || !uuid.test(actorId)) throw Error("INVALID_SALES_OPERATIONS_SCOPE");
  return `${settings[area].prefix}:${actorId}:${workspaceId}`;
}
function validateCommand(area: SalesOperationsArea, raw: unknown): Command {
  const value = object(raw), required = ["contractVersion", "operation", "projectId", "companyId", "locationId", "idempotencyKey", "correlationId", "payload", ...(area === "autonomy" ? ["expectedVersion"] : ["expectedWorkflowVersion", "expectedConversationVersion"])];
  if (Object.keys(value).some(key => ![...required, "allocationProof"].includes(key)) || required.some(key => !Object.hasOwn(value, key)) || value.contractVersion !== settings[area].contract
    || !(settings[area].operations as readonly string[]).includes(String(value.operation)) || ["projectId", "companyId", "locationId", "idempotencyKey", "correlationId"].some(key => !uuid.test(String(value[key])))) throw Error("INVALID_SALES_OPERATIONS_COMMAND");
  const versions = area === "autonomy" ? [value.expectedVersion] : [value.expectedConversationVersion, value.expectedWorkflowVersion];
  if (versions.some(version => !Number.isSafeInteger(version) || Number(version) < 0) || area === "conversation" && Number(value.expectedWorkflowVersion) < 1) throw Error("INVALID_SALES_OPERATIONS_COMMAND");
  object(value.payload);
  if (value.allocationProof !== undefined) { const proof = object(value.allocationProof); if (Object.keys(proof).sort().join(",") !== "allocationId,leaseToken,version" || !uuid.test(String(proof.allocationId)) || !uuid.test(String(proof.leaseToken)) || !Number.isSafeInteger(proof.version) || Number(proof.version) < 1) throw Error("INVALID_ALLOCATION_PROOF"); }
  return value as unknown as Command;
}
export function salesOperationsPending(area: SalesOperationsArea, workspaceId: string, actorId: string) {
  const key = storageKey(area, workspaceId, actorId), cached = pending.get(key); if (cached) return cached;
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(key); if (raw === null) return undefined;
    if (new TextEncoder().encode(raw).byteLength > 260000) throw Error("STORAGE_LIMIT");
    const saved = object(JSON.parse(raw));
    if (Object.keys(saved).sort().join(",") !== "actorId,area,body,workspaceId" || saved.area !== area || saved.actorId !== actorId || saved.workspaceId !== workspaceId || typeof saved.body !== "string" || new TextEncoder().encode(saved.body).byteLength > 120000) throw Error("STORAGE_BINDING");
    const value: SalesOperationsPending = { area, body: saved.body, command: validateCommand(area, JSON.parse(saved.body)), state: "UNKNOWN", currentRead: false, retryAllowed: false };
    pending.set(key, value); return value;
  } catch {
    const value: SalesOperationsPending = { area, body: "", command: {} as Command, state: "UNKNOWN", currentRead: false, retryAllowed: false, damaged: true };
    pending.set(key, value); return value;
  }
}
function clear(area: SalesOperationsArea, workspaceId: string, actorId: string) {
  const key = storageKey(area, workspaceId, actorId); window.sessionStorage.removeItem(key); pending.delete(key); notify();
}
export class SalesOperationsBrowserError extends Error { constructor(readonly outcome: "DENIED" | "UNKNOWN", readonly code: string) { super(code); } }
async function request(url: string, init: RequestInit) {
  const controller = new AbortController(), source = init.signal, abort = () => controller.abort();
  source?.addEventListener("abort", abort, { once: true }); if (source?.aborted) controller.abort();
  const boundedRequest = new Request(new URL(url, window.location.origin), { ...init, signal: controller.signal });
  const timer = setTimeout(() => { controller.abort(); void boundedRequest.signal.aborted; }, 15000);
  try {
    const response = await csrfFetch(boundedRequest), reader = response.body?.getReader(); if (!reader) throw Error("EMPTY_RESPONSE");
    const cancel = () => { void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener("abort", cancel, { once: true });
    const limit = (init.method ?? "GET") === "GET" || new URL(url, window.location.origin).pathname.endsWith("/reconcile") ? 4000000 : 262144;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { if (controller.signal.aborted) throw Error("ABORTED"); const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) throw Error("RESPONSE_TOO_LARGE"); chunks.push(next.value); }
      if (controller.signal.aborted) throw Error("ABORTED");
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { response, data: object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) };
    } finally { controller.signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } finally { clearTimeout(timer); source?.removeEventListener("abort", abort); }
}
function bindScope(value: Record<string, unknown>, workspaceId: string, scope: SalesConversationScope) {
  if (value.workspaceId !== workspaceId || value.canContact !== false || Object.entries(scope).some(([key, id]) => value[key] !== id)) throw Error("SALES_OPERATIONS_SCOPE_MISMATCH");
}
function workflow(raw: unknown, workspaceId: string, scope: SalesConversationScope) {
  const value = object(raw); bindScope(value, workspaceId, scope);
  if (!uuid.test(String(value.id)) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !sha.test(String(value.evidenceDigest))) throw Error("INVALID_CONVERSATION_WORKFLOW");
}
function validateRead(area: SalesOperationsArea, raw: unknown, workspaceId: string, scope: SalesConversationScope) {
  const value = object(raw); bindScope(value, workspaceId, scope);
  if (value.contractVersion !== settings[area].contract || value.source !== "database" || typeof value.canWrite !== "boolean") throw Error("INVALID_SALES_OPERATIONS_READ");
  if (area === "conversation") {
    workflow(value.workflow, workspaceId, scope);
    if (!sha.test(String(value.factsDigest)) || typeof value.canApproveFacts !== "boolean" || ["facts", "sources", "turns"].some(key => !Array.isArray(value[key]))) throw Error("INVALID_CONVERSATION_READ");
    for (const turn of value.turns as unknown[]) { const item = object(turn); if (!uuid.test(String(item.id)) || item.draft !== null && object(item.draft).canSend !== false) throw Error("INVALID_CONVERSATION_TURN"); }
  } else {
    if (["allocations", "policies", "quotes", "financialEvidence", "outcomes", "improvements"].some(key => !Array.isArray(value[key]))) throw Error("INVALID_OPERATIONS_READ");
    if (value.projection !== "RESOURCE" && value.projection !== "PORTFOLIO" || typeof value.canApprovePolicies !== "boolean") throw Error("INVALID_OPERATIONS_PROJECTION");
    if (!Array.isArray(value.opportunities) || value.opportunities.length > 200 || typeof value.opportunitiesHasMore !== "boolean") throw Error("INVALID_OPERATIONS_OPPORTUNITIES");
    for (const rawOpportunity of value.opportunities) {
      const opportunity = object(rawOpportunity);
      if (opportunity.workspaceId !== workspaceId || opportunity.projectId !== scope.projectId || opportunity.canContact !== false || typeof opportunity.canWrite !== "boolean" || ["workflowId", "companyId", "locationId"].some(key => !uuid.test(String(opportunity[key])))
        || !Number.isSafeInteger(opportunity.workflowVersion) || Number(opportunity.workflowVersion) < 1 || !sha.test(String(opportunity.evidenceDigest)) || typeof opportunity.companyName !== "string" || typeof opportunity.locationLabel !== "string") throw Error("INVALID_OPERATIONS_OPPORTUNITY");
    }
    if (value.workflow !== null) workflow(value.workflow, workspaceId, scope);
  }
  return value;
}
export async function readSalesOperations(workspaceId: string, scope: SalesConversationScope, signal?: AbortSignal): Promise<SalesOperationsRead> {
  return readArea("autonomy", workspaceId, scope, signal) as Promise<SalesOperationsRead>;
}
export async function readSalesConversation(workspaceId: string, scope: SalesConversationScope, signal?: AbortSignal): Promise<SalesConversationRead> {
  return readArea("conversation", workspaceId, scope, signal) as Promise<SalesConversationRead>;
}
async function readArea(area: SalesOperationsArea, workspaceId: string, scope: SalesConversationScope, signal?: AbortSignal) {
  const { response, data } = await request(`${settings[area].path}?${new URLSearchParams({ workspaceId, ...scope })}`, { method: "GET", credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw Error("SALES_OPERATIONS_READ_DENIED"); return validateRead(area, data, workspaceId, scope) as unknown as SalesOperationsRead | SalesConversationRead;
}
export function markSalesOperationsCurrentRead(area: SalesOperationsArea, workspaceId: string, actorId: string, reference: { idempotencyKey: string; correlationId: string }, scope: SalesConversationScope) {
  const value = salesOperationsPending(area, workspaceId, actorId);
  if (value && !value.damaged && value.state === "UNKNOWN" && value.command.idempotencyKey === reference.idempotencyKey && value.command.correlationId === reference.correlationId && Object.entries(scope).every(([key, id]) => value.command[key as keyof SalesConversationScope] === id)) { value.currentRead = true; notify(); }
}
function receipt(area: SalesOperationsArea, raw: Record<string, unknown>, command: Command, workspaceId: string) {
  if (!uuid.test(String(raw.commandId)) || !uuid.test(String(raw.auditReference)) || typeof raw.replayed !== "boolean") throw Error("INVALID_SALES_OPERATIONS_RECEIPT");
  const data = object(raw.data), scope = { projectId: command.projectId, companyId: command.companyId, locationId: command.locationId };
  if (area === "conversation") {
    workflow(data.workflow, workspaceId, scope); const saved = object(data.conversation);
    const expected = command as SalesConversationCommand;
    if (!uuid.test(String(saved.id)) || !Number.isSafeInteger(saved.version) || Number(saved.version) < Math.max(1, expected.expectedConversationVersion) || Number(object(data.workflow).version) < expected.expectedWorkflowVersion || !sha.test(String(saved.factsDigest)) || data.canContact !== false) throw Error("INVALID_CONVERSATION_RECEIPT");
    const required: Record<string, string | null> = { authorize_topic_extraction: "topicPermissionId", record_answer_fact: "factId", record_topic: "topicTurnId", draft_answer: "draftTurnId", advance_conversation: "topicTurnId", stop_conversation: null };
    if (required[command.operation] && !uuid.test(String(data[required[command.operation]!]))) throw Error("INVALID_CONVERSATION_RECEIPT");
  } else {
    bindScope(data, workspaceId, scope);
    if (!Number.isSafeInteger(data.version) || Number(data.version) < Math.max(1, (command as SalesOperationsCommand).expectedVersion)) throw Error("INVALID_OPERATIONS_RECEIPT");
    const required: Record<string, string> = { configure_portfolio: "portfolioId", plan_portfolio: "portfolioId", claim_allocation: "allocationId", settle_allocation: "allocationId", register_price_rule: "ruleId", propose_price: "quoteId", apply_quote: "quoteId", register_financial_evidence: "financialEvidenceId", record_outcome: "outcomeId", propose_improvement: "improvementId", review_improvement: "improvementId", promote_improvement: "improvementId" };
    if (!uuid.test(String(data[required[command.operation]]))) throw Error("INVALID_OPERATIONS_RECEIPT");
  }
  return data;
}
export async function writeSalesOperations(area: SalesOperationsArea, workspaceId: string, actorId: string, command: Command, retryOriginal = false) {
  assertSalesWriteBarrier(area, workspaceId, actorId);
  const key = storageKey(area, workspaceId, actorId), existing = salesOperationsPending(area, workspaceId, actorId); let value: SalesOperationsPending;
  if (existing) { if (!retryOriginal || existing.damaged || existing.state !== "UNKNOWN" || !existing.currentRead || !existing.retryAllowed || JSON.stringify(command) !== existing.body) throw new SalesOperationsBrowserError("UNKNOWN", "SALES_OPERATIONS_RECOVERY_REQUIRED"); value = existing; }
  else { validateCommand(area, command); const body = JSON.stringify(command); if (new TextEncoder().encode(body).byteLength > 120000) throw new SalesOperationsBrowserError("DENIED", "COMMAND_TOO_LARGE"); value = { area, body, command, state: "IN_FLIGHT", currentRead: false, retryAllowed: false }; }
  value.state = "IN_FLIGHT"; value.currentRead = false; value.retryAllowed = false;
  try { window.sessionStorage.setItem(key, JSON.stringify({ area, workspaceId, actorId, body: value.body })); pending.set(key, value); notify(); }
  catch { if (existing) { value.state = "UNKNOWN"; pending.set(key, value); notify(); } throw new SalesOperationsBrowserError(existing ? "UNKNOWN" : "DENIED", "RECOVERY_STORAGE_UNAVAILABLE"); }
  try {
    const { response, data } = await request(`${settings[area].path}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", body: value.body, headers: { "content-type": "application/json", "idempotency-key": command.idempotencyKey, "x-correlation-id": command.correlationId } });
    if (!response.ok) { if (response.status >= 500) throw Error("SERVER_UNKNOWN"); if (!existing) clear(area, workspaceId, actorId); throw new SalesOperationsBrowserError(existing ? "UNKNOWN" : "DENIED", String(data.code ?? "SALES_OPERATIONS_DENIED")); }
    if (data.contractVersion !== settings[area].contract || data.persisted !== true || data.correlationId !== command.correlationId) throw Error("INVALID_SALES_OPERATIONS_RECEIPT");
    receipt(area, data, command, workspaceId); clear(area, workspaceId, actorId); return data;
  } catch (error) {
    if (error instanceof SalesOperationsBrowserError && error.outcome === "DENIED") throw error;
    value.state = "UNKNOWN"; value.currentRead = false; value.retryAllowed = false; pending.set(key, value); notify(); throw new SalesOperationsBrowserError("UNKNOWN", "SALES_OPERATIONS_OUTCOME_UNKNOWN");
  }
}
export async function reconcileSalesOperations(area: SalesOperationsArea, workspaceId: string, actorId: string) {
  const value = salesOperationsPending(area, workspaceId, actorId); if (!value || value.damaged || !value.currentRead) throw new SalesOperationsBrowserError("UNKNOWN", "CURRENT_READ_REQUIRED");
  try {
    const { response, data } = await request(`${settings[area].path}/reconcile?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", body: value.body, headers: { "content-type": "application/json", "idempotency-key": value.command.idempotencyKey, "x-correlation-id": value.command.correlationId } });
    const contract = area === "autonomy" ? "website-sales-operations-reconcile-v1" : "website-sales-conversation-reconcile-v1";
    if (!response.ok || data.contractVersion !== contract || data.correlationId !== value.command.correlationId || salesOperationsPending(area, workspaceId, actorId) !== value) throw Error("RECONCILE_DENIED");
    if (data.status === "COMMITTED") { receipt(area, data, value.command, workspaceId); clear(area, workspaceId, actorId); return "COMMITTED" as const; }
    if (data.status === "NOT_FOUND") { value.retryAllowed = true; notify(); return "NOT_FOUND" as const; } throw Error("INVALID_RECONCILIATION");
  } catch { throw new SalesOperationsBrowserError("UNKNOWN", "SALES_OPERATIONS_RECONCILE_UNAVAILABLE"); }
}
