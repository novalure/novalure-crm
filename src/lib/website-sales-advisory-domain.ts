import { createHash } from 'node:crypto';
import { advisoryIdentitySchema, advisoryRecordSchema, type AdvisoryIdentity, type AdvisoryRecord, type AdvisoryReference } from './website-sales-advisory-types';

export interface AdvisoryContext { identity: AdvisoryIdentity; workflowId: string; workflowVersion: number }
export interface AdvisoryEvaluation<T> { status: 'READY' | 'NEEDS_CLARIFICATION' | 'INSUFFICIENT_DATA' | 'BLOCKED'; value: T | null; reasons: string[]; externalEffectAllowed: false; requiresServerAuthorization: true }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  throw Error('ADVISORY_NON_CANONICAL_VALUE');
}
export function advisoryDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function advisoryContentSha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function advisoryRecordDigest(raw: Omit<AdvisoryRecord<unknown>, 'digest'> | AdvisoryRecord<unknown>): string { const { digest: ignored, revokedAt: revocation, ...body } = raw as AdvisoryRecord<unknown>; void ignored; void revocation; return advisoryDigest(body); }
export function advisoryReference(record: Pick<AdvisoryRecord, 'id' | 'version' | 'digest'>): AdvisoryReference { return { id: record.id, version: record.version, digest: record.digest }; }
export function verifyAdvisoryRecord(raw: unknown, ctx: AdvisoryContext, nowISO: string): AdvisoryRecord {
  const row = advisoryRecordSchema.parse(raw), scope = advisoryIdentitySchema.parse(ctx.identity), now = Date.parse(nowISO);
  if (!Number.isFinite(now) || !Number.isSafeInteger(ctx.workflowVersion) || ctx.workflowVersion < 1 || advisoryDigest(row.identity) !== advisoryDigest(scope) || row.workflowId !== ctx.workflowId || row.workflowVersion > ctx.workflowVersion || row.digest !== advisoryRecordDigest(row) || row.revokedAt || Date.parse(row.createdAt) > now || row.validUntil && Date.parse(row.validUntil) <= now) throw Error('ADVISORY_CURRENT_RECORD_REQUIRED');
  return row;
}
