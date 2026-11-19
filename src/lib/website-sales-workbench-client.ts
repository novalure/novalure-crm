"use client";

import { csrfFetch } from "@/lib/security/csrf-client";

export type WebsiteSalesBrowserCommand = {
  operation: "register_location" | "observe" | "qualify" | "prepare_offer" | "stop";
  projectId: string; companyId: string; locationId?: string; locationVersion?: number; expectedVersion?: number;
  payload: Record<string, unknown>;
};
export type WebsiteSalesPendingCommand = {
  command: WebsiteSalesBrowserCommand; body: string; idempotencyKey: string; correlationId: string;
  state: "IN_FLIGHT" | "UNKNOWN"; currentRead: boolean; createdAt: string; recoveryError?: true;
};
const pending = new Map<string, WebsiteSalesPendingCommand>();
const pendingListeners = new Set<() => void>();
function notifyPending() { for (const listener of pendingListeners) listener(); }
export function subscribeWebsiteSalesPending(listener: () => void): () => void {
  pendingListeners.add(listener); return () => { pendingListeners.delete(listener); };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class WebsiteSalesBrowserError extends Error {
  constructor(readonly outcome: "DENIED" | "UNKNOWN", readonly code: string) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RECEIPT");
  return value as Record<string, unknown>;
}
function recoveryKey(workspaceId: string, actorId: string): string {
  if (!uuid.test(workspaceId) || !uuid.test(actorId)) throw new WebsiteSalesBrowserError("DENIED", "RECOVERY_SCOPE_INVALID");
  return `novalure.website-sales.pending.v1:${actorId}:${workspaceId}`;
}
function damagedRecovery(): WebsiteSalesPendingCommand {
  return { command: { operation: "observe", projectId: "", companyId: "", payload: {} }, body: "", idempotencyKey: "", correlationId: "", state: "UNKNOWN", currentRead: false, createdAt: "", recoveryError: true };
}
function loadPending(workspaceId: string, actorId: string): WebsiteSalesPendingCommand | undefined {
  const key = recoveryKey(workspaceId, actorId), cached = pending.get(key);
  if (cached) return cached;
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return undefined;
    if (new TextEncoder().encode(raw).byteLength > 300_000) throw new Error();
    const saved = record(JSON.parse(raw));
    if (Object.keys(saved).sort().join(",") !== "actorId,body,correlationId,createdAt,format,idempotencyKey,workspaceId"
      || saved.format !== "website-sales-pending-v1" || saved.workspaceId !== workspaceId || saved.actorId !== actorId
      || typeof saved.body !== "string" || new TextEncoder().encode(saved.body).byteLength > 131_072
      || typeof saved.idempotencyKey !== "string" || !uuid.test(saved.idempotencyKey) || typeof saved.correlationId !== "string" || !uuid.test(saved.correlationId)
      || typeof saved.createdAt !== "string" || !Number.isFinite(Date.parse(saved.createdAt))) throw new Error();
    const body = record(JSON.parse(saved.body));
    if (Object.keys(body).some(field => !["contractVersion", "operation", "projectId", "companyId", "locationId", "locationVersion", "expectedVersion", "payload", "idempotencyKey", "correlationId"].includes(field))
      || body.contractVersion !== "website-sales-ireland-v1" || body.idempotencyKey !== saved.idempotencyKey || body.correlationId !== saved.correlationId
      || !["register_location", "observe", "qualify", "prepare_offer", "stop"].includes(String(body.operation))
      || typeof body.projectId !== "string" || !uuid.test(body.projectId) || typeof body.companyId !== "string" || !uuid.test(body.companyId)
      || body.operation !== "register_location" && (typeof body.locationId !== "string" || !uuid.test(body.locationId))) throw new Error();
    const payload = record(body.payload);
    if (body.operation === "observe") {
      const identity = record(record(payload.prospect).identity);
      if (identity.workspaceId !== workspaceId || identity.projectId !== body.projectId || identity.companyId !== body.companyId || identity.locationId !== body.locationId) throw new Error();
    }
    const command = Object.fromEntries(Object.entries(body).filter(([field]) => !["contractVersion", "idempotencyKey", "correlationId"].includes(field)));
    const value: WebsiteSalesPendingCommand = { command: command as unknown as WebsiteSalesBrowserCommand, body: saved.body,
      idempotencyKey: saved.idempotencyKey, correlationId: saved.correlationId, createdAt: saved.createdAt, state: "UNKNOWN", currentRead: false };
    pending.set(key, value); return value;
  } catch { const value = damagedRecovery(); pending.set(key, value); return value; }
}
function persistPending(workspaceId: string, actorId: string, value: WebsiteSalesPendingCommand): void {
  if (new TextEncoder().encode(value.body).byteLength > 131_072) throw new WebsiteSalesBrowserError("DENIED", "COMMAND_TOO_LARGE");
  const encoded = JSON.stringify({ format: "website-sales-pending-v1", workspaceId, actorId,
    body: value.body, idempotencyKey: value.idempotencyKey, correlationId: value.correlationId, createdAt: value.createdAt });
  if (new TextEncoder().encode(encoded).byteLength > 300_000) throw new WebsiteSalesBrowserError("DENIED", "RECOVERY_RECORD_TOO_LARGE");
  window.sessionStorage.setItem(recoveryKey(workspaceId, actorId), encoded);
}
export function websiteSalesPending(workspaceId: string, actorId: string): WebsiteSalesPendingCommand | null {
  const value = loadPending(workspaceId, actorId); return value ? structuredClone(value) : null;
}
export function websiteSalesMarkCurrentRead(workspaceId: string, actorId: string, scope: Pick<WebsiteSalesBrowserCommand, "projectId" | "companyId" | "locationId">,
  reference: { idempotencyKey: string; correlationId: string }): void {
  const value = loadPending(workspaceId, actorId);
  if (value?.state === "UNKNOWN" && !value.recoveryError && value.idempotencyKey === reference.idempotencyKey && value.correlationId === reference.correlationId
    && value.command.projectId === scope.projectId && value.command.companyId === scope.companyId
    && value.command.locationId === scope.locationId) { value.currentRead = true; notifyPending(); }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
async function evidenceDigest(command: WebsiteSalesBrowserCommand): Promise<string | null> {
  if (command.operation !== "observe") return typeof command.payload.expectedEvidenceDigest === "string" ? command.payload.expectedEvidenceDigest : null;
  const prospect = record(command.payload.prospect);
  if (!Array.isArray(prospect.evidence)) throw new Error();
  // Match the server's explicit schema transforms for receipt binding only.
  // Readiness, identity verification and investment decisions remain server-authoritative.
  const identity = (raw: unknown) => Object.fromEntries(Object.entries(record(raw)).map(([key, value]) => [key, typeof value === "string" ? value.toLowerCase() : value]));
  const evidence = prospect.evidence.map(raw => {
    const item = record(raw);
    return { ...item, identity: identity(item.identity), evidenceId: String(item.evidenceId).trim(),
      finding: String(item.finding).trim(), validityCondition: String(item.validityCondition).trim() };
  }).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const source = { ...prospect, identity: identity(prospect.identity), domain: typeof prospect.domain === "string" ? prospect.domain.trim().toLowerCase() : null, evidence };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(source)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function boundedJson(request: Request, write: boolean): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const boundedRequest = new Request(request, { signal: controller.signal });
  const parentAbort = () => controller.abort();
  request.signal.addEventListener("abort", parentAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ (async () => {
      const response = await csrfFetch(boundedRequest);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new WebsiteSalesBrowserError(write && (response.status >= 500 || response.status >= 300 && response.status < 400) ? "UNKNOWN" : "DENIED", `HTTP_${response.status}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("INVALID_RECEIPT");
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await reader.read();
        if (controller.signal.aborted) throw new Error("ABORTED");
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 262_144) { void reader.cancel().catch(() => undefined); throw new Error("RECEIPT_TOO_LARGE"); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => undefined);
      reject(new WebsiteSalesBrowserError(write ? "UNKNOWN" : "DENIED", boundedRequest.signal.aborted ? "TIMEOUT" : "ABORT_UNCONFIRMED"));
    }, 15_000); })]);
  } catch (error) {
    if (error instanceof WebsiteSalesBrowserError) throw error;
    throw new WebsiteSalesBrowserError(write ? "UNKNOWN" : "DENIED", "RESPONSE_UNCONFIRMED");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", parentAbort);
  }
}
export async function readWebsiteSalesWorkbench(workspaceId: string, query: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const search = new URLSearchParams({ ...query, workspaceId });
  const value = await boundedJson(new Request(new URL(`/api/crm/website-sales/workbench?${search}`, window.location.origin), { cache: "no-store", credentials: "same-origin", redirect: "error", signal }), false);
  if (value.contractVersion !== "website-sales-workbench-v1" || value.source !== "database" || value.workspaceId !== workspaceId
    || value.view !== query.view || value.canContact !== false || typeof value.canWrite !== "boolean"
    || (query.projectId && value.projectId !== query.projectId) || (query.companyId && value.companyId !== query.companyId))
    throw new WebsiteSalesBrowserError("DENIED", "SCOPE_MISMATCH");
  try {
    if (query.view === "detail") {
      const location = record(value.location);
      if (location.id !== query.locationId || location.workspaceId !== workspaceId || location.projectId !== query.projectId || location.companyId !== query.companyId
        || location.countryCode !== "IE" || typeof location.sourceUrl !== "string" || new URL(location.sourceUrl).protocol !== "https:") throw new Error();
      if (value.workflow !== null) {
        const workflow = record(value.workflow);
        if (workflow.workspaceId !== workspaceId || workflow.projectId !== query.projectId || workflow.companyId !== query.companyId || workflow.locationId !== query.locationId
          || workflow.canContact !== false || !Number.isSafeInteger(workflow.version) || Number(workflow.version) < 1
          || !["OBSERVED", "QUALIFIED", "OFFER_DRAFT", "STOPPED"].includes(String(workflow.status))) throw new Error();
        if (value.contact !== null && record(value.contact).id !== workflow.contactId) throw new Error();
      } else if (value.contact !== null) {
        throw new Error();
      }
      if (value.observation !== null) {
        const identity = record(record(record(value.observation).prospect).identity);
        if (identity.workspaceId !== workspaceId || identity.projectId !== query.projectId || identity.companyId !== query.companyId || identity.locationId !== query.locationId) throw new Error();
        if (!Array.isArray(record(record(value.observation).prospect).evidence)) throw new Error();
      }
    } else {
      if (!Array.isArray(value.items)) throw new Error();
      const page = record(value.page);
      if (!Number.isSafeInteger(page.limit) || Number(page.limit) < 1 || Number(page.limit) > 50 || typeof page.hasMore !== "boolean"
        || page.nextCursor !== null && (typeof page.nextCursor !== "string" || !uuid.test(page.nextCursor))) throw new Error();
      for (const raw of value.items) {
        const item = record(raw);
        if (typeof item.id !== "string" || !uuid.test(item.id)) throw new Error();
        if (query.view === "locations") {
          if (item.workspaceId !== workspaceId || item.projectId !== query.projectId || item.companyId !== query.companyId || typeof item.address !== "string") throw new Error();
        } else if (typeof item.name !== "string") throw new Error();
      }
    }
  } catch { throw new WebsiteSalesBrowserError("DENIED", "INVALID_SCOPED_RESPONSE"); }
  return value;
}
export async function commandWebsiteSalesWorkbench(workspaceId: string, actorId: string, command: WebsiteSalesBrowserCommand, reconcile = false): Promise<Record<string, unknown>> {
  const key = recoveryKey(workspaceId, actorId), existing = loadPending(workspaceId, actorId);
  if (existing?.recoveryError) throw new WebsiteSalesBrowserError("UNKNOWN", "RECOVERY_RECORD_INVALID");
  if (existing && (!reconcile || existing.state !== "UNKNOWN" || !existing.currentRead)) throw new WebsiteSalesBrowserError("UNKNOWN", "ORIGINAL_ACTION_REQUIRED");
  if (reconcile && !existing) throw new WebsiteSalesBrowserError("DENIED", "NO_PENDING_ACTION");
  const attempt: WebsiteSalesPendingCommand = existing ?? (() => {
    const stable = structuredClone(command), idempotencyKey = crypto.randomUUID(), correlationId = crypto.randomUUID();
    return { command: stable, idempotencyKey, correlationId, body: JSON.stringify({ contractVersion: "website-sales-ireland-v1", ...stable, idempotencyKey, correlationId }), state: "IN_FLIGHT" as const, currentRead: false, createdAt: new Date().toISOString() };
  })();
  attempt.state = "IN_FLIGHT"; attempt.currentRead = false;
  try { persistPending(workspaceId, actorId, attempt); }
  catch (error) {
    if (error instanceof WebsiteSalesBrowserError && !existing) throw error;
    const blocked = existing ?? damagedRecovery(); blocked.state = "UNKNOWN"; pending.set(key, blocked); notifyPending();
    throw new WebsiteSalesBrowserError("UNKNOWN", "RECOVERY_STORAGE_UNAVAILABLE");
  }
  pending.set(key, attempt); notifyPending();
  try {
    const value = await boundedJson(new Request(new URL(`/api/crm/website-sales?workspaceId=${encodeURIComponent(workspaceId)}`, window.location.origin), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey, "X-Correlation-Id": attempt.correlationId }, body: attempt.body,
    }), true);
    if (value.contractVersion !== "website-sales-ireland-v1" || value.persisted !== true || value.correlationId !== attempt.correlationId
      || typeof value.commandId !== "string" || !uuid.test(value.commandId) || typeof value.auditReference !== "string" || !uuid.test(value.auditReference) || typeof value.replayed !== "boolean") throw new Error();
    const data = record(value.data), entity = record(attempt.command.operation === "register_location" ? data.location : data.workflow);
    if (entity.workspaceId !== workspaceId || entity.projectId !== attempt.command.projectId || entity.companyId !== attempt.command.companyId
      || attempt.command.locationId && entity.locationId !== attempt.command.locationId || typeof entity.id !== "string" || !uuid.test(entity.id)
      || !Number.isSafeInteger(entity.version) || Number(entity.version) < 1
      || (attempt.command.operation === "register_location" ? entity.countryCode !== "IE" : entity.canContact !== false)) throw new Error();
    if (attempt.command.operation !== "register_location") {
      const expectedDigest = await evidenceDigest(attempt.command);
      if (typeof entity.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(entity.evidenceDigest)
        || expectedDigest && entity.evidenceDigest !== expectedDigest || !Number.isSafeInteger(entity.locationVersion) || Number(entity.locationVersion) < 1
        || !["OBSERVED", "QUALIFIED", "OFFER_DRAFT", "STOPPED"].includes(String(entity.status))) throw new Error();
    }
    window.sessionStorage.removeItem(key); pending.delete(key); notifyPending(); return data;
  } catch (error) {
    if (!existing && error instanceof WebsiteSalesBrowserError && error.outcome === "DENIED") {
      try { window.sessionStorage.removeItem(key); pending.delete(key); notifyPending(); throw error; }
      catch (storageError) { if (storageError === error) throw error; }
    }
    // A later denial cannot establish whether the earlier uncertain write committed.
    attempt.state = "UNKNOWN"; notifyPending();
    throw new WebsiteSalesBrowserError("UNKNOWN", "ORIGINAL_ACTION_UNCONFIRMED");
  }
}
