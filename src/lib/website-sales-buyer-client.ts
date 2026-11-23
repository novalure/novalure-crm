'use client';

import type { z } from 'zod';
import { csrfFetch } from './security/csrf-client';
import { advisoryBuyerCommandSchema, advisoryBuyerProjectionSchema, advisoryBuyerReceiptSchema, advisoryBuyerReconcileSchema, type WebsiteSalesAdvisoryBuyerRead } from './website-sales-advisory-types';

export type BuyerCommand = z.infer<typeof advisoryBuyerCommandSchema>;
const path = '/api/public/website-sales/advisory', prefix = 'novalure.website-sales-buyer.pending.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const ref = (value: { id: string; version: number; digest: string }) => `${value.id}:${value.version}:${value.digest}`;
export type BuyerPending = { actorUserId: string; grantId: string; command: BuyerCommand; body: string; state: 'IN_FLIGHT' | 'UNKNOWN'; currentRead: boolean; retryAllowed: boolean; damaged?: true };
const pending = new Map<string, BuyerPending>(), latest = new Map<string, WebsiteSalesAdvisoryBuyerRead>(), tokenGrant = new Map<string, string>();
const listeners = new Set<() => void>(), notify = () => listeners.forEach(listener => listener());
const key = (grantId: string, actorUserId: string) => `${prefix}:${actorUserId}:${grantId}`;
export function subscribeBuyerPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export class BuyerBrowserError extends Error { constructor(readonly outcome: 'DENIED' | 'UNKNOWN', readonly code: string) { super(code); } }

/** Recovery storage has original bytes and account identity only. An access token is never stored here. */
export function buyerPending(grantId: string): BuyerPending | undefined {
  if (!uuid.test(grantId)) throw Error('BUYER_GRANT_INVALID');
  if (typeof window === 'undefined') return undefined;
  try {
    for (let index = 0; index < window.sessionStorage.length; index++) {
      const storedKey = window.sessionStorage.key(index);
      if (!storedKey?.startsWith(`${prefix}:`) || !storedKey.endsWith(`:${grantId}`) || pending.has(storedKey)) continue;
      const actorUserId = storedKey.slice(prefix.length + 1, -(grantId.length + 1));
      try {
        if (!uuid.test(actorUserId)) throw Error();
        const raw = window.sessionStorage.getItem(storedKey); if (!raw || bytes(raw) > 65536) throw Error();
        const saved = JSON.parse(raw) as Record<string, unknown>;
        if (!saved || Object.keys(saved).sort().join(',') !== 'actorUserId,body,grantId' || saved.actorUserId !== actorUserId || saved.grantId !== grantId || typeof saved.body !== 'string' || bytes(saved.body) > 32768) throw Error();
        const command = advisoryBuyerCommandSchema.parse(JSON.parse(saved.body));
        if (command.grantId !== grantId) throw Error();
        pending.set(storedKey, { actorUserId, grantId, command, body: saved.body, state: 'UNKNOWN', currentRead: false, retryAllowed: false });
      } catch { pending.set(storedKey, { actorUserId, grantId, command: {} as BuyerCommand, body: '', state: 'UNKNOWN', currentRead: false, retryAllowed: false, damaged: true }); }
    }
    return [...pending.values()].find(value => value.grantId === grantId);
  } catch {
    return { actorUserId: '', grantId, command: {} as BuyerCommand, body: '', state: 'UNKNOWN', currentRead: false, retryAllowed: false, damaged: true };
  }
}
function clear(item: BuyerPending) { window.sessionStorage.removeItem(key(item.grantId, item.actorUserId)); pending.delete(key(item.grantId, item.actorUserId)); notify(); }
function identity(data: WebsiteSalesAdvisoryBuyerRead, item?: BuyerPending) {
  if (!data.canWrite || !data.actorUserId || !data.actorBindingHash || data.authAssurance !== 'AUTHENTICATED_ACCOUNT' || Date.parse(data.expiresAt) <= Date.now()) throw Error('BUYER_AUTHENTICATED_ACCOUNT_REQUIRED');
  if (item && (item.damaged || item.actorUserId !== data.actorUserId || item.command.actorBindingHash !== data.actorBindingHash || item.grantId !== data.grantId || ref(item.command.packetRef) !== ref(data.packetRef) || data.grantVersion < item.command.expectedGrantVersion)) throw Error('BUYER_ORIGINAL_ACCOUNT_REQUIRED');
}
function remember(token: string, data: WebsiteSalesAdvisoryBuyerRead) {
  tokenGrant.set(token, data.grantId); latest.set(data.grantId, data);
  const item = buyerPending(data.grantId);
  if (item && !item.damaged && item.state === 'UNKNOWN') {
    try { identity(data, item); item.currentRead = true; } catch { item.currentRead = false; item.retryAllowed = false; }
  }
  notify();
}
async function request(token: string, suffix: '' | '/reconcile', init: RequestInit) {
  if (!tokenPattern.test(token)) throw new BuyerBrowserError('DENIED', 'BUYER_LINK_INVALID');
  const controller = new AbortController(), source = init.signal, abort = () => controller.abort();
  source?.addEventListener('abort', abort, { once: true }); if (source?.aborted) abort();
  const timer = setTimeout(abort, 20000), headers = new Headers(init.headers);
  headers.set('x-sales-review-token', token); headers.set('Accept', 'application/json');
  try {
    const response = await csrfFetch(path + suffix, { ...init, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    const reader = response.body?.getReader(); if (!reader) throw Error('BUYER_RESPONSE_UNAVAILABLE');
    const cancel = () => { void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { if (controller.signal.aborted) throw Error('BUYER_RESPONSE_UNAVAILABLE'); const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 524288) throw Error('BUYER_RESPONSE_TOO_LARGE'); chunks.push(next.value); }
      if (controller.signal.aborted) throw Error('BUYER_RESPONSE_UNAVAILABLE');
      const value = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
      return { response, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown };
    } finally { controller.signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } finally { clearTimeout(timer); source?.removeEventListener('abort', abort); }
}
export async function readBuyer(token: string, signal?: AbortSignal) {
  const oldGrant = tokenGrant.get(token);
  if (oldGrant) { latest.delete(oldGrant); const item = buyerPending(oldGrant); if (item) { item.currentRead = false; item.retryAllowed = false; } notify(); }
  const result = await request(token, '', { method: 'GET', signal });
  if (!result.response.ok) throw new BuyerBrowserError('DENIED', 'BUYER_ACCESS_UNAVAILABLE');
  const data = advisoryBuyerProjectionSchema.parse(result.data);
  if (Date.parse(data.expiresAt) <= Date.now()) throw new BuyerBrowserError('DENIED', 'BUYER_ACCESS_UNAVAILABLE');
  remember(token, data); return data;
}
function receipt(raw: unknown, item: BuyerPending) {
  const value = advisoryBuyerReceiptSchema.parse(raw), effect = value.data, command = item.command;
  if (value.correlationId !== command.correlationId || effect.grantId !== item.grantId || effect.actorUserId !== item.actorUserId || effect.actorBindingHash !== command.actorBindingHash || ref(effect.packetRef) !== ref(command.packetRef) || effect.grantVersion < command.expectedGrantVersion || effect.stepId !== command.stepId || command.disposition === 'QUESTION' && effect.questionId === null ||
    (command.stepId === null ? effect.stepVersion !== null || effect.questionId === null : effect.stepVersion === null || effect.stepVersion < command.expectedStepVersion!)) throw Error('BUYER_RECEIPT_BINDING_DENIED');
  return value;
}
export async function writeBuyer(token: string, data: WebsiteSalesAdvisoryBuyerRead, command: BuyerCommand, retryOriginal = false) {
  identity(data); if (latest.get(data.grantId) !== data) throw new BuyerBrowserError('DENIED', 'BUYER_CURRENT_READ_REQUIRED');
  const old = buyerPending(data.grantId); let item: BuyerPending;
  if (old) {
    identity(data, old);
    if (!retryOriginal || old.state !== 'UNKNOWN' || !old.currentRead || !old.retryAllowed || JSON.stringify(command) !== old.body) throw new BuyerBrowserError('UNKNOWN', 'BUYER_RECOVERY_REQUIRED');
    item = old;
  } else {
    advisoryBuyerCommandSchema.parse(command);
    if (command.grantId !== data.grantId || command.actorBindingHash !== data.actorBindingHash || ref(command.packetRef) !== ref(data.packetRef) || command.expectedGrantVersion !== data.grantVersion || command.stepId !== null && !data.steps.some(step => step.id === command.stepId && step.version === command.expectedStepVersion)) throw new BuyerBrowserError('DENIED', 'BUYER_CURRENT_SELECTION_REQUIRED');
    const body = JSON.stringify(command); if (bytes(body) > 32768) throw new BuyerBrowserError('DENIED', 'BUYER_COMMAND_TOO_LARGE');
    item = { actorUserId: data.actorUserId!, grantId: data.grantId, command, body, state: 'IN_FLIGHT', currentRead: false, retryAllowed: false };
  }
  item.state = 'IN_FLIGHT'; item.currentRead = false; item.retryAllowed = false;
  try { window.sessionStorage.setItem(key(item.grantId, item.actorUserId), JSON.stringify({ actorUserId: item.actorUserId, grantId: item.grantId, body: item.body })); pending.set(key(item.grantId, item.actorUserId), item); notify(); }
  catch { if (old) { item.state = 'UNKNOWN'; notify(); } throw new BuyerBrowserError(old ? 'UNKNOWN' : 'DENIED', 'BUYER_RECOVERY_STORAGE_UNAVAILABLE'); }
  try {
    const result = await request(token, '', { method: 'POST', body: item.body, headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey, 'x-correlation-id': command.correlationId } });
    if (!result.response.ok) { if (result.response.status >= 500) throw Error(); if (!old) clear(item); throw new BuyerBrowserError(old ? 'UNKNOWN' : 'DENIED', 'BUYER_WRITE_DENIED'); }
    receipt(result.data, item); clear(item); latest.delete(data.grantId); return;
  } catch (error) {
    if (error instanceof BuyerBrowserError && error.outcome === 'DENIED') throw error;
    item.state = 'UNKNOWN'; item.currentRead = false; item.retryAllowed = false; pending.set(key(item.grantId, item.actorUserId), item); notify();
    throw new BuyerBrowserError('UNKNOWN', 'BUYER_OUTCOME_UNKNOWN');
  }
}
export async function reconcileBuyer(token: string, data: WebsiteSalesAdvisoryBuyerRead) {
  const item = buyerPending(data.grantId); if (!item) throw new BuyerBrowserError('UNKNOWN', 'BUYER_RECOVERY_REQUIRED');
  identity(data, item);
  if (!item.currentRead || latest.get(data.grantId) !== data) throw new BuyerBrowserError('UNKNOWN', 'BUYER_CURRENT_READ_REQUIRED');
  try {
    const result = await request(token, '/reconcile', { method: 'POST', body: item.body, headers: { 'content-type': 'application/json', 'idempotency-key': item.command.idempotencyKey, 'x-correlation-id': item.command.correlationId } });
    const value = advisoryBuyerReconcileSchema.parse(result.data);
    if (!result.response.ok || buyerPending(data.grantId) !== item || value.correlationId !== item.command.correlationId) throw Error();
    if (value.status === 'NOT_FOUND') { item.retryAllowed = true; notify(); return 'NOT_FOUND' as const; }
    receipt(value.receipt, item); identity(value.currentData, item);
    if (value.currentData.grantId !== data.grantId) throw Error();
    clear(item); remember(token, value.currentData); return 'COMMITTED' as const;
  } catch { throw new BuyerBrowserError('UNKNOWN', 'BUYER_RECONCILE_UNKNOWN'); }
}
