'use client';

import { csrfFetch } from './security/csrf-client';
import { assertSalesWriteBarrier } from './website-sales-write-barrier';
import { websiteSalesAdvisoryCommandSchema, websiteSalesAdvisoryReceiptSchema, websiteSalesAdvisoryReconcileSchema, type WebsiteSalesAdvisoryCommand } from './website-sales-advisory-types';
import { validateWebsiteSalesAdvisoryRead } from './website-sales-advisory-types';
import { websiteSalesAdvisoryPath, type WebsiteSalesAdvisoryScope } from './website-sales-advisory-api-types';

const prefix = 'novalure.website-sales-advisory.pending.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bodyLimit = 262144;

export type AdvisoryPending = {
  command: WebsiteSalesAdvisoryCommand;
  body: string;
  state: 'IN_FLIGHT' | 'UNKNOWN';
  currentRead: boolean;
  retryAllowed: boolean;
  damaged?: true;
};
const pending = new Map<string, AdvisoryPending>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function subscribeAdvisoryPending(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function key(workspaceId: string, actorId: string) {
  if (!uuid.test(workspaceId) || !uuid.test(actorId)) throw Error('INVALID_ADVISORY_SCOPE');
  return `${prefix}:${actorId}:${workspaceId}`;
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_ADVISORY_RESPONSE');
  return raw as Record<string, unknown>;
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Storage contains only the exact original command, never provider credentials or a new retry key. */
export function advisoryPending(workspaceId: string, actorId: string): AdvisoryPending | undefined {
  const selected = key(workspaceId, actorId), cached = pending.get(selected);
  if (cached) return cached;
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(selected);
    if (raw === null) return undefined;
    if (bytes(raw) > bodyLimit * 2) throw Error();
    const saved = object(JSON.parse(raw));
    if (Object.keys(saved).sort().join(',') !== 'actorId,body,workspaceId' || saved.workspaceId !== workspaceId ||
      saved.actorId !== actorId || typeof saved.body !== 'string' || bytes(saved.body) > bodyLimit) throw Error();
    const command = websiteSalesAdvisoryCommandSchema.parse(JSON.parse(saved.body));
    const item: AdvisoryPending = { command, body: saved.body, state: 'UNKNOWN', currentRead: false, retryAllowed: false };
    pending.set(selected, item);
    return item;
  } catch {
    const item: AdvisoryPending = { command: {} as WebsiteSalesAdvisoryCommand, body: '', state: 'UNKNOWN', currentRead: false, retryAllowed: false, damaged: true };
    pending.set(selected, item);
    return item;
  }
}

function clear(workspaceId: string, actorId: string) {
  window.sessionStorage.removeItem(key(workspaceId, actorId));
  pending.delete(key(workspaceId, actorId));
  notify();
}
export class AdvisoryBrowserError extends Error {
  constructor(readonly outcome: 'DENIED' | 'UNKNOWN', readonly code: string) { super(code); }
}

/** The deadline covers headers and body; malformed, oversized and interrupted reads cannot acknowledge a write. */
async function request(url: string, init: RequestInit) {
  const controller = new AbortController(), source = init.signal, abort = () => controller.abort();
  source?.addEventListener('abort', abort, { once: true });
  if (source?.aborted) abort();
  const bounded = new Request(new URL(url, window.location.origin), { ...init, signal: controller.signal });
  const timer = setTimeout(abort, 20000);
  try {
    const response = await csrfFetch(bounded), reader = response.body?.getReader();
    if (!reader) throw Error('EMPTY_ADVISORY_RESPONSE');
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [], limit = init.method === 'GET' || url.includes('/reconcile') ? 4000000 : 524288;
      let size = 0;
      for (;;) {
        if (controller.signal.aborted) throw Error('ADVISORY_READ_ABORTED');
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw Error('ADVISORY_RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
      if (controller.signal.aborted) throw Error('ADVISORY_READ_ABORTED');
      const combined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      return { response, data: object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined))) };
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally { clearTimeout(timer); source?.removeEventListener('abort', abort); }
}

function identity(raw: unknown, workspaceId: string, scope: WebsiteSalesAdvisoryScope) {
  const value = object(raw);
  if (value.workspaceId !== workspaceId || (['projectId', 'companyId', 'locationId'] as const).some(field => value[field] !== scope[field]))
    throw Error('ADVISORY_SCOPE_MISMATCH');
}

export async function readAdvisory(workspaceId: string, scope: WebsiteSalesAdvisoryScope, workflowId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ workspaceId, workflowId, projectId: scope.projectId, companyId: scope.companyId, ...(scope.locationId ? { locationId: scope.locationId } : {}) });
  const { response, data } = await request(`${websiteSalesAdvisoryPath}?${query}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw Error('ADVISORY_READ_DENIED');
  return validateWebsiteSalesAdvisoryRead(data, { workspaceId, ...scope }, workflowId);
}

export function markAdvisoryCurrentRead(workspaceId: string, actorId: string, reference: { idempotencyKey: string; correlationId: string; workflowId: string }, scope: WebsiteSalesAdvisoryScope) {
  const item = advisoryPending(workspaceId, actorId);
  if (item && !item.damaged && item.state === 'UNKNOWN' && item.command.idempotencyKey === reference.idempotencyKey &&
    item.command.correlationId === reference.correlationId && item.command.workflowId === reference.workflowId && (['projectId', 'companyId', 'locationId'] as const).every(field => item.command[field] === scope[field])) {
    item.currentRead = true;
    notify();
  }
}

function receipt(raw: unknown, command: WebsiteSalesAdvisoryCommand, workspaceId: string) {
  const value = websiteSalesAdvisoryReceiptSchema.parse(raw), effect = value.data;
  identity(effect.identity, workspaceId, command);
  if (value.correlationId !== command.correlationId || effect.workflowId !== command.workflowId ||
    effect.version < command.expectedVersion || effect.workflowVersion < command.expectedWorkflowVersion ||
    (effect.recordId === null) !== (effect.recordDigest === null)) throw Error('INVALID_ADVISORY_RECEIPT');
  return value;
}

export async function writeAdvisory(workspaceId: string, actorId: string, command: WebsiteSalesAdvisoryCommand, retryOriginal = false) {
  assertSalesWriteBarrier('advisory', workspaceId, actorId);
  const selected = key(workspaceId, actorId), old = advisoryPending(workspaceId, actorId);
  let item: AdvisoryPending;
  if (old) {
    if (!retryOriginal || old.damaged || old.state !== 'UNKNOWN' || !old.currentRead || !old.retryAllowed || JSON.stringify(command) !== old.body)
      throw new AdvisoryBrowserError('UNKNOWN', 'ADVISORY_RECOVERY_REQUIRED');
    item = old;
  } else {
    websiteSalesAdvisoryCommandSchema.parse(command);
    const body = JSON.stringify(command);
    if (bytes(body) > bodyLimit) throw new AdvisoryBrowserError('DENIED', 'ADVISORY_COMMAND_TOO_LARGE');
    item = { command, body, state: 'IN_FLIGHT', currentRead: false, retryAllowed: false };
  }
  item.state = 'IN_FLIGHT'; item.currentRead = false; item.retryAllowed = false;
  try {
    window.sessionStorage.setItem(selected, JSON.stringify({ workspaceId, actorId, body: item.body }));
    pending.set(selected, item); notify();
  } catch {
    if (old) { item.state = 'UNKNOWN'; pending.set(selected, item); notify(); }
    throw new AdvisoryBrowserError(old ? 'UNKNOWN' : 'DENIED', 'ADVISORY_RECOVERY_STORAGE_UNAVAILABLE');
  }
  try {
    const { response, data } = await request(`${websiteSalesAdvisoryPath}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: item.body,
      headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey, 'x-correlation-id': command.correlationId },
    });
    if (!response.ok) {
      if (response.status >= 500) throw Error('ADVISORY_SERVER_UNKNOWN');
      if (!old) clear(workspaceId, actorId);
      throw new AdvisoryBrowserError(old ? 'UNKNOWN' : 'DENIED', String(data.code ?? 'ADVISORY_DENIED'));
    }
    receipt(data, command, workspaceId);
    clear(workspaceId, actorId);
    return data;
  } catch (error) {
    if (error instanceof AdvisoryBrowserError && error.outcome === 'DENIED') throw error;
    item.state = 'UNKNOWN'; item.currentRead = false; item.retryAllowed = false;
    pending.set(selected, item); notify();
    throw new AdvisoryBrowserError('UNKNOWN', 'ADVISORY_OUTCOME_UNKNOWN');
  }
}

export async function reconcileAdvisory(workspaceId: string, actorId: string) {
  const item = advisoryPending(workspaceId, actorId);
  if (!item || item.damaged || !item.currentRead) throw new AdvisoryBrowserError('UNKNOWN', 'ADVISORY_CURRENT_READ_REQUIRED');
  try {
    const { response, data } = await request(`${websiteSalesAdvisoryPath}/reconcile?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', body: item.body,
      headers: { 'content-type': 'application/json', 'idempotency-key': item.command.idempotencyKey, 'x-correlation-id': item.command.correlationId },
    });
    const result = websiteSalesAdvisoryReconcileSchema.parse(data);
    if (!response.ok || advisoryPending(workspaceId, actorId) !== item || result.correlationId !== item.command.correlationId)
      throw Error('INVALID_ADVISORY_RECONCILE');
    if (result.status === 'COMMITTED') {
      receipt(result.receipt, item.command, workspaceId);
      validateWebsiteSalesAdvisoryRead(result.currentData, { workspaceId, projectId: item.command.projectId, companyId: item.command.companyId, locationId: item.command.locationId }, item.command.workflowId);
      clear(workspaceId, actorId);
      return 'COMMITTED' as const;
    }
    if (result.status === 'NOT_FOUND') { item.retryAllowed = true; notify(); return 'NOT_FOUND' as const; }
    throw Error('INVALID_ADVISORY_RECONCILE');
  } catch { throw new AdvisoryBrowserError('UNKNOWN', 'ADVISORY_RECONCILE_UNKNOWN'); }
}
