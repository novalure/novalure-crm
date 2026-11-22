import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  commerceContractDraftSchema, commerceDeliveryAcceptanceSchema, commerceFinancialSnapshotSchema, commerceIdentitySchema,
  commerceInvoiceRequestSchema, commerceOfferSchema, commercePolicySchema, commerceRecordSchema, commerceReferenceSchema, commerceSubscriptionTermsSchema,
  commerceTemplateSchema, commerceTime, websiteSalesCommerceSourceEventSchema,
  type CommerceIdentity, type CommerceRecord, type CommerceReference, type WebsiteSalesCommerceSourceEvent,
} from './website-sales-commerce-types';

export type CommerceEvaluation<T> = { status: 'READY' | 'BLOCKED' | 'NEEDS_RECONCILIATION'; reasons: string[]; value: T | null; externalEffectAllowed: false; requiresServerAuthorization: true };
export type CommerceContext = { identity: CommerceIdentity; workflowId: string; workflowVersion: number };
export type CommerceContractDraft = z.infer<typeof commerceContractDraftSchema>;
export type CommerceInvoiceRequest = z.infer<typeof commerceInvoiceRequestSchema>;
type SourceEvent = WebsiteSalesCommerceSourceEvent;
type SignatureEvent = Extract<SourceEvent, { kind: 'SIGNATURE' }>;
type SubscriptionEvent = Extract<SourceEvent, { kind: 'SUBSCRIPTION' }>;
type DeliveryEvent = Extract<SourceEvent, { kind: 'PROVIDER_DELIVERY' }>;
export type CommerceSourcesInput = { identity: CommerceIdentity; workflowId: string; events: SourceEvent[]; historyComplete?: boolean };
export interface CommerceCurrentSources { events: SourceEvent[]; invalidatedEventIds: string[]; complete: boolean }
const max = BigInt(Number.MAX_SAFE_INTEGER), zero = BigInt(0), bps = BigInt(10_000);
function evaluation(value: null, reasons?: string[], reconciliation?: boolean): CommerceEvaluation<never>;
function evaluation<T>(value: T, reasons?: string[], reconciliation?: boolean): CommerceEvaluation<T>;
function evaluation<T>(value: T | null, reasons: string[] = [], reconciliation = false): CommerceEvaluation<T> { return { status: reasons.length ? reconciliation ? 'NEEDS_RECONCILIATION' : 'BLOCKED' : 'READY', reasons: [...new Set(reasons)], value, externalEffectAllowed: false, requiresServerAuthorization: true }; }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  throw new Error('COMMERCE_NON_CANONICAL_VALUE');
}
export function commerceDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function commerceContentSha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/** Revocation is a current projection, not a rewrite of the immutable authored record. */
export function commerceRecordDigest(record: Omit<CommerceRecord<unknown>, 'digest'> | CommerceRecord<unknown>): string {
  const { digest: ignoredDigest, revokedAt: ignoredRevocation, ...immutable } = record as CommerceRecord<unknown>;
  void ignoredDigest; void ignoredRevocation; return commerceDigest(immutable);
}
export function commerceRecordReference(record: Pick<CommerceRecord<unknown>, 'id' | 'version' | 'digest'>): CommerceReference { return { id: record.id, version: record.version, digest: record.digest }; }
const sameRef = (a: CommerceReference, b: CommerceReference) => a.id === b.id && a.version === b.version && a.digest === b.digest;
const sameScope = (a: CommerceIdentity, b: CommerceIdentity) => commerceDigest(a) === commerceDigest(b);
function at(value: string): number { return Date.parse(commerceTime.parse(value)); }
function currentSource(source: { observedAt: string; validUntil: string }, now: number): boolean { return at(source.observedAt) <= now && at(source.validUntil) > now; }
function record<T extends z.ZodType>(raw: unknown, schema: T, ctx: CommerceContext, now: number, canonicalOffer = false): CommerceRecord<z.infer<T>> {
  const row = commerceRecordSchema(schema).parse(raw) as CommerceRecord<z.infer<T>>;
  commerceIdentitySchema.parse(ctx.identity);
  if (!Number.isSafeInteger(ctx.workflowVersion) || ctx.workflowVersion < 1 || !sameScope(row.identity, ctx.identity) || row.workflowId !== ctx.workflowId || row.workflowVersion > ctx.workflowVersion) throw new Error('COMMERCE_RECORD_SCOPE_OR_VERSION_DENIED');
  if (!canonicalOffer && row.digest !== commerceRecordDigest(row)) throw new Error('COMMERCE_RECORD_DIGEST_MISMATCH');
  if (row.revokedAt || at(row.createdAt) > now || row.validUntil && at(row.validUntil) <= now) throw new Error('COMMERCE_RECORD_NOT_CURRENT');
  return row;
}
function validEvent(raw: unknown, ctx: Pick<CommerceContext, 'identity' | 'workflowId'>, now: number): SourceEvent {
  const event = websiteSalesCommerceSourceEventSchema.parse(raw);
  if (!sameScope(event.identity, ctx.identity) || event.workflowId !== ctx.workflowId) throw new Error('COMMERCE_SOURCE_SCOPE_DENIED');
  if (at(event.occurredAt) > now || at(event.retrievedAt) > now || at(event.retrievedAt) < at(event.occurredAt)) throw new Error('COMMERCE_SOURCE_TIME_INVALID');
  return event;
}
function safe(value: bigint): number { if (value < zero || value > max) throw new Error('COMMERCE_MONEY_OVERFLOW'); return Number(value); }
const sum = (values: number[]) => safe(values.reduce((total, value) => total + BigInt(value), zero));
function attempt<T>(fn: () => CommerceEvaluation<T>): CommerceEvaluation<T> {
  try { return fn(); } catch (error) { return evaluation(null, [error instanceof z.ZodError ? 'COMMERCE_INPUT_INVALID' : error instanceof Error && /^COMMERCE_[A-Z_]+$/.test(error.message) ? error.message : 'COMMERCE_INPUT_INVALID']); }
}
const sourceResourceKey = (event: SourceEvent) => commerceDigest({ system: event.source.system, provider: event.source.provider, accountReference: event.source.accountReference, resourceType: event.source.resourceType, resourceId: event.source.resourceId });
/** First host retrieval/proof metadata remains immutable in storage, but a new read is not a new provider fact. */
export function commerceSourceFactDigest(event: SourceEvent): string {
  return commerceDigest({ identity: event.identity, workflowId: event.workflowId, source: event.source, kind: event.kind, payload: event.payload, occurredAt: event.occurredAt, supersedesEventId: event.supersedesEventId, confidence: event.confidence });
}
/** Never falls back to an older positive when the newest resource is voided, reversed or unverified. */
export function resolveCurrentWebsiteSalesCommerceSources(input: CommerceSourcesInput, nowISO: string): CommerceEvaluation<CommerceCurrentSources> {
  return attempt<CommerceCurrentSources>(() => {
    commerceIdentitySchema.parse(input.identity); z.uuid().parse(input.workflowId);
    const now = at(nowISO), rows = z.array(websiteSalesCommerceSourceEventSchema).max(1000).parse(input.events).map(event => validEvent(event, input, now));
    const reasons: string[] = input.historyComplete === false ? ['COMMERCE_FINANCIAL_HISTORY_LIMITED'] : [];
    const byId = new Map<string, SourceEvent>(), aliases = new Map<string, string>(), versions = new Map<string, SourceEvent>(), latest = new Map<string, SourceEvent>();
    for (const event of [...rows].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
      const prior = byId.get(event.eventId);
      if (prior && commerceSourceFactDigest(prior) !== commerceSourceFactDigest(event)) throw new Error('COMMERCE_SOURCE_EVENT_ID_CONFLICT');
      if (prior) continue; byId.set(event.eventId, event);
      const resource = sourceResourceKey(event), versionKey = `${resource}:${event.source.version}`, previous = versions.get(versionKey);
      if (previous) {
        if (commerceSourceFactDigest(previous) !== commerceSourceFactDigest(event)) throw new Error('COMMERCE_SOURCE_VERSION_FORK');
        aliases.set(event.eventId, previous.eventId); continue;
      }
      versions.set(versionKey, event);
      const newest = latest.get(resource);
      if (newest && newest.kind !== event.kind) throw new Error('COMMERCE_SOURCE_KIND_CHANGED');
      if (!newest || event.source.version > newest.source.version) latest.set(resource, event);
    }
    const idOf = (id: string) => aliases.get(id) ?? id, eventOf = (id: string) => byId.get(idOf(id));
    for (const event of versions.values()) if (event.supersedesEventId) {
      const previous = eventOf(event.supersedesEventId);
      if (!previous) reasons.push('COMMERCE_SOURCE_PREDECESSOR_MISSING');
      else if (sourceResourceKey(event) !== sourceResourceKey(previous) || previous.source.version >= event.source.version) throw new Error('COMMERCE_SOURCE_PREDECESSOR_CONFLICT');
    }
    const reversals = new Map<string, SourceEvent[]>();
    for (const event of latest.values()) if (event.kind === 'REVERSAL') {
      const target = eventOf(event.payload.reversesEventId);
      if (!target) { reasons.push('COMMERCE_REVERSAL_TARGET_MISSING'); continue; }
      if (event.payload.reversedEventDigest !== commerceSourceFactDigest(target)) throw new Error('COMMERCE_REVERSAL_DIGEST_MISMATCH');
      if (event.confidence !== 'PROVIDER_VERIFIED' || target.confidence !== 'PROVIDER_VERIFIED' || event.source.system !== target.source.system || event.source.provider !== target.source.provider || event.source.accountReference !== target.source.accountReference || at(event.occurredAt) < at(target.occurredAt)) throw new Error('COMMERCE_REVERSAL_SOURCE_DENIED');
      reversals.set(idOf(target.eventId), [...(reversals.get(idOf(target.eventId)) ?? []), event]);
    }
    const cache = new Map<string, boolean>();
    const reversed = (rawId: string, path = new Set<string>()): boolean => {
      const id = idOf(rawId), known = cache.get(id); if (known !== undefined) return known;
      if (path.has(id)) throw new Error('COMMERCE_REVERSAL_CYCLE');
      const next = new Set(path).add(id), active = (reversals.get(id) ?? []).filter(event => !reversed(event.eventId, next));
      if (active.length > 1) throw new Error('COMMERCE_REVERSAL_DUPLICATE');
      cache.set(id, active.length === 1); return active.length === 1;
    };
    for (const event of versions.values()) reversed(event.eventId);
    const invalidated = new Set<string>(), invalidResources = new Set<string>();
    for (const event of versions.values()) if (reversed(event.eventId)) {
      invalidated.add(event.eventId); invalidResources.add(sourceResourceKey(event));
      if (latest.get(sourceResourceKey(event))?.eventId !== event.eventId) reasons.push('COMMERCE_REVERSAL_OLDER_VERSION_REQUIRES_RECONCILIATION');
    }
    const current = [...latest.values()].filter(event => !invalidResources.has(sourceResourceKey(event)) && !reversed(event.eventId));
    return evaluation({ events: current, invalidatedEventIds: [...invalidated], complete: reasons.length === 0 }, reasons, true);
  });
}
function effectiveSource<K extends SourceEvent['kind']>(input: CommerceSourcesInput, kind: K, matches: (event: Extract<SourceEvent, { kind: K }>) => boolean, nowISO: string): CommerceEvaluation<Extract<SourceEvent, { kind: K }>> {
  const resolved = resolveCurrentWebsiteSalesCommerceSources(input, nowISO);
  if (resolved.status !== 'READY' || !resolved.value) return evaluation(null, resolved.reasons, true);
  const candidates = resolved.value.events.filter((event): event is Extract<SourceEvent, { kind: K }> => event.kind === kind && event.confidence === 'PROVIDER_VERIFIED').filter(matches);
  if (!candidates.length) return evaluation(null, [resolved.value.invalidatedEventIds.length ? 'COMMERCE_CURRENT_SOURCE_REVERSED' : 'COMMERCE_CURRENT_AUTHORITATIVE_SOURCE_REQUIRED']);
  candidates.sort((a, b) => at(b.occurredAt) - at(a.occurredAt));
  const first = candidates[0]!;
  const sameTime = candidates.filter(event => at(event.occurredAt) === at(first.occurredAt));
  if (new Set(sameTime.map(event => commerceDigest(event.payload))).size > 1) return evaluation(null, ['COMMERCE_CURRENT_SOURCE_CONFLICT'], true);
  return evaluation(first);
}
export function resolveWebsiteSalesCommerceSignature(input: CommerceSourcesInput & { contractRef: CommerceReference; documentSha256: string; requiredAssurance: 'PROVIDER_ATTESTED' | 'ADVANCED' | 'QUALIFIED' }, nowISO: string): CommerceEvaluation<SignatureEvent> {
  return attempt<SignatureEvent>(() => {
    commerceReferenceSchema.parse(input.contractRef); z.hash('sha256').parse(input.documentSha256);
    const requiredAssurance = z.enum(['PROVIDER_ATTESTED', 'ADVANCED', 'QUALIFIED']).parse(input.requiredAssurance);
    const matches = (event: SignatureEvent) => event.source.system === 'SIGNATURE_PROVIDER' && sameRef(event.payload.contractRef, input.contractRef) && event.payload.documentSha256 === input.documentSha256;
    const selected = effectiveSource(input, 'SIGNATURE', matches, nowISO); if (!selected.value || selected.status !== 'READY') return selected;
    const current = resolveCurrentWebsiteSalesCommerceSources(input, nowISO).value!.events.filter((event): event is SignatureEvent => event.kind === 'SIGNATURE' && event.confidence === 'PROVIDER_VERIFIED' && matches(event));
    if (current.some(event => ['VOIDED', 'DECLINED', 'EXPIRED'].includes(event.payload.status))) return evaluation(null, ['COMMERCE_SIGNATURE_NOT_CURRENT']);
    const rank = { EMAIL_ACCESS: 0, PROVIDER_ATTESTED: 1, ADVANCED: 2, QUALIFIED: 3 }, event = selected.value;
    const auditProof = !!event.payload.providerAuditProofDigests?.length || !!event.payload.auditProofReferences?.some(reference => currentSource(reference, at(nowISO)));
    if (event.payload.status !== 'SIGNED' || !event.payload.signedAt || at(event.payload.signedAt) > at(nowISO) || rank[event.payload.assurance] < rank[requiredAssurance] || !event.payload.providerSignedDocumentDigests?.length || !auditProof) return evaluation(null, ['COMMERCE_VERIFIED_EXACT_SIGNATURE_REQUIRED']);
    return selected;
  });
}
export function resolveWebsiteSalesCommerceDelivery(input: CommerceSourcesInput & { documentKind: DeliveryEvent['payload']['documentKind']; documentRef: CommerceReference; documentSha256: string; recipientDigest: string }, nowISO: string): CommerceEvaluation<DeliveryEvent> {
  return attempt<DeliveryEvent>(() => {
    commerceReferenceSchema.parse(input.documentRef); z.hash('sha256').parse(input.documentSha256); z.hash('sha256').parse(input.recipientDigest);
    z.enum(['OFFER', 'CONTRACT', 'INVOICE_REQUEST']).parse(input.documentKind);
    const matches = (event: DeliveryEvent) => event.source.system === 'DELIVERY_PROVIDER' && event.payload.documentKind === input.documentKind && sameRef(event.payload.documentRef, input.documentRef) && event.payload.documentSha256 === input.documentSha256 && event.payload.recipientDigest === input.recipientDigest;
    const selected = effectiveSource(input, 'PROVIDER_DELIVERY', matches, nowISO); if (!selected.value || selected.status !== 'READY') return selected;
    const current = resolveCurrentWebsiteSalesCommerceSources(input, nowISO).value!.events.filter((event): event is DeliveryEvent => event.kind === 'PROVIDER_DELIVERY' && event.confidence === 'PROVIDER_VERIFIED' && matches(event));
    if (current.some(event => ['BOUNCED', 'COMPLAINED', 'FAILED'].includes(event.payload.status)) || selected.value.payload.status !== 'DELIVERED') return evaluation(null, ['COMMERCE_VERIFIED_CURRENT_DELIVERY_REQUIRED']);
    return selected;
  });
}
export function resolveWebsiteSalesCommerceSubscription(input: CommerceSourcesInput & { terms: z.infer<typeof commerceSubscriptionTermsSchema> }, nowISO: string): CommerceEvaluation<SubscriptionEvent> {
  return attempt<SubscriptionEvent>(() => {
    const terms = commerceSubscriptionTermsSchema.parse(input.terms), matches = (event: SubscriptionEvent) => ['SERVICE_AUTHORITY', 'ACCOUNTING'].includes(event.source.system) && sameRef(event.payload.contractRef, terms.contractRef) && event.payload.planKey === terms.planKey && event.payload.termsDigest === terms.termsDigest && event.payload.originalServiceStartAt === terms.originalServiceStartAt && event.payload.currency === terms.currency;
    const selected = effectiveSource(input, 'SUBSCRIPTION', matches, nowISO); if (!selected.value || selected.status !== 'READY') return selected;
    const current = resolveCurrentWebsiteSalesCommerceSources(input, nowISO).value!.events.filter((event): event is SubscriptionEvent => event.kind === 'SUBSCRIPTION' && event.confidence === 'PROVIDER_VERIFIED' && matches(event));
    if (current.some(event => ['CANCEL_PENDING', 'CANCELLED', 'EXPIRED'].includes(event.payload.status)) || !['ACTIVE', 'PAUSED'].includes(selected.value.payload.status)) return evaluation(null, ['COMMERCE_CURRENT_SUBSCRIPTION_TERMS_REQUIRED']);
    return selected;
  });
}
/** Exactly A0/C03's net threshold; nonstandard terms do not change the step count. */
export function requiredWebsiteSalesContractApprovalSteps(raw: unknown): 1 | 2 {
  const financial = commerceFinancialSnapshotSchema.parse(raw);
  if (financial.currency !== 'EUR') throw new Error('COMMERCE_EUR_APPROVAL_POLICY_REQUIRED');
  return financial.netMinor >= 500_000 ? 2 : 1;
}
function policyCurrent(policy: z.infer<typeof commercePolicySchema>, now: number): boolean {
  return at(policy.validUntil) > now && [policy.standardTermsReference, policy.accountingSourceReference, policy.accountingProfile.sourceReference, policy.financialSnapshot.taxReference, ...(policy.contractTerm ? [policy.contractTerm.sourceReference] : [])].every(source => currentSource(source, now));
}
function taxMatches(policy: z.infer<typeof commercePolicySchema>): boolean {
  const f = policy.financialSnapshot;
  return f.currency === policy.accountingProfile.currency && f.taxMinor === safe((BigInt(f.netMinor) * BigInt(policy.accountingProfile.taxRateBps) + BigInt(5000)) / bps);
}
export function prepareWebsiteSalesContract(input: { offer: CommerceRecord<z.infer<typeof commerceOfferSchema>>; template: CommerceRecord<z.infer<typeof commerceTemplateSchema>>; policy: CommerceRecord<z.infer<typeof commercePolicySchema>>; variables: Record<string, string> }, ctx: CommerceContext, nowISO: string): CommerceEvaluation<CommerceContractDraft> {
  return attempt<CommerceContractDraft>(() => {
    const now = at(nowISO), offer = record(input.offer, commerceOfferSchema, ctx, now, true), template = record(input.template, commerceTemplateSchema, ctx, now), policy = record(input.policy, commercePolicySchema, ctx, now);
    const p = policy.payload, t = template.payload, o = offer.payload;
    if (!sameRef(commerceRecordReference(offer), o.offerRef) || !sameRef(p.offerRef, o.offerRef) || commerceDigest(p.financialSnapshot) !== commerceDigest(o.financial) || !policyCurrent(p, now) || !taxMatches(p)) return evaluation(null, ['COMMERCE_SOURCED_FINANCIAL_POLICY_REQUIRED']);
    if (!['APPROVED', 'SENT', 'ACCEPTED'].includes(o.status) || !o.approvalReference) return evaluation(null, ['COMMERCE_APPROVED_OFFER_REQUIRED']);
    if (!currentSource(t.legalReviewReference, now) || at(t.validUntil) <= now || commerceContentSha256(t.content) !== t.contentSha256) return evaluation(null, ['COMMERCE_CURRENT_REVIEWED_LEGAL_TEMPLATE_REQUIRED']);
    if (p.paymentTerms.installments.length > p.maxInstallments || new Set(t.allowedVariableKeys).size !== t.allowedVariableKeys.length) return evaluation(null, ['COMMERCE_TEMPLATE_OR_SCHEDULE_INVALID']);
    const money = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
    const protectedValues: Record<string, string> = { NET_EUR: money(o.financial.netMinor), TAX_EUR: money(o.financial.taxMinor), GROSS_EUR: money(o.financial.grossMinor), CUSTOMER_EMAIL: o.recipientEmail,
      ISSUER_LEGAL_NAME: p.accountingProfile.issuerLegalName, ISSUER_ADDRESS: p.accountingProfile.issuerAddress, TAX_IDENTIFIER: p.accountingProfile.taxIdentifier ?? '',
      ...(p.contractTerm ? { CONTRACT_START_AT: p.contractTerm.startAt, CONTRACT_END_AT: p.contractTerm.endAt, CONTRACT_FULL_NET_EUR: money(p.contractTerm.fullNetMinor) } : {}) };
    const supplied = z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(2000)).parse(input.variables);
    if (Object.keys(supplied).some(key => !t.allowedVariableKeys.includes(key) || key in protectedValues && supplied[key] !== protectedValues[key])) return evaluation(null, ['COMMERCE_TEMPLATE_VARIABLE_DENIED']);
    const variables = { ...supplied, ...protectedValues };
    let missing = false;
    const body = t.content.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_token, key: string) => {
      if (!t.allowedVariableKeys.includes(key) || !Object.prototype.hasOwnProperty.call(variables, key)) { missing = true; return ''; }
      return variables[key] ?? '';
    });
    if (missing || /\{\{|\}\}|\u0000/.test(body)) return evaluation(null, ['COMMERCE_TEMPLATE_VARIABLE_UNRESOLVED']);
    const draft = commerceContractDraftSchema.parse({ offerRef: o.offerRef, templateRef: commerceRecordReference(template), policyRef: commerceRecordReference(policy), title: t.title, body,
      documentSha256: commerceContentSha256(body), recipientEmail: o.recipientEmail, recipientDigest: o.recipientDigest, financial: o.financial,
      standardTerms: o.financial.termsDigest === p.standardTermsDigest, status: 'DRAFT', paymentTerms: p.paymentTerms, ...(p.contractTerm ? { contractTerm: p.contractTerm } : {}), signatureSourceEventId: null, deliverySourceEventId: null });
    return evaluation(draft);
  });
}
export function prepareWebsiteSalesInvoiceRequest(input: { contract: CommerceRecord<CommerceContractDraft>; policy: CommerceRecord<z.infer<typeof commercePolicySchema>>; signature: SignatureEvent; sourceEvents: SourceEvent[]; historyComplete?: boolean;
  deliveryAcceptance: CommerceRecord<z.infer<typeof commerceDeliveryAcceptanceSchema>> | null; stage: CommerceInvoiceRequest['stage']; installmentIds: string[] }, ctx: CommerceContext, nowISO: string): CommerceEvaluation<CommerceInvoiceRequest> {
  return attempt<CommerceInvoiceRequest>(() => {
    const now = at(nowISO), contract = record(input.contract, commerceContractDraftSchema, ctx, now), policy = record(input.policy, commercePolicySchema, ctx, now);
    const c = contract.payload, p = policy.payload, ref = commerceRecordReference(contract);
    const signatureResult = resolveWebsiteSalesCommerceSignature({ identity: ctx.identity, workflowId: ctx.workflowId, events: input.sourceEvents,
      ...(input.historyComplete === undefined ? {} : { historyComplete: input.historyComplete }), contractRef: ref, documentSha256: c.documentSha256, requiredAssurance: p.signatureAssurance }, nowISO);
    if (signatureResult.status !== 'READY' || !signatureResult.value) return evaluation(null, signatureResult.reasons, signatureResult.status === 'NEEDS_RECONCILIATION');
    const signature = signatureResult.value;
    if (commerceSourceFactDigest(validEvent(input.signature, ctx, now)) !== commerceSourceFactDigest(signature)) return evaluation(null, ['COMMERCE_SIGNATURE_NOT_CURRENT']);
    if (!sameRef(c.policyRef, commerceRecordReference(policy)) || !policyCurrent(p, now) || !taxMatches(p) || commerceDigest(c.financial) !== commerceDigest(p.financialSnapshot) || commerceDigest(c.paymentTerms) !== commerceDigest(p.paymentTerms) || commerceDigest(c.contractTerm ?? null) !== commerceDigest(p.contractTerm ?? null)) return evaluation(null, ['COMMERCE_CONTRACT_POLICY_BINDING_DENIED']);
    const rank = { EMAIL_ACCESS: 0, PROVIDER_ATTESTED: 1, ADVANCED: 2, QUALIFIED: 3 };
    if (signature.kind !== 'SIGNATURE' || signature.confidence !== 'PROVIDER_VERIFIED' || signature.source.system !== 'SIGNATURE_PROVIDER' || signature.payload.status !== 'SIGNED' || !sameRef(signature.payload.contractRef, ref) || signature.payload.documentSha256 !== c.documentSha256 || !signature.payload.signedAt || at(signature.payload.signedAt) > now || at(signature.payload.signedAt) < at(contract.createdAt) || at(signature.occurredAt) < at(signature.payload.signedAt) || rank[signature.payload.assurance] < rank[p.signatureAssurance]) return evaluation(null, ['COMMERCE_VERIFIED_EXACT_SIGNATURE_REQUIRED']);
    if (['VOIDED', 'DECLINED', 'EXPIRED'].includes(c.status) || commerceContentSha256(c.body) !== c.documentSha256) return evaluation(null, ['COMMERCE_CONTRACT_NOT_ACTIONABLE']);
    const acceptance = input.deliveryAcceptance ? record(input.deliveryAcceptance, commerceDeliveryAcceptanceSchema, ctx, now) : null;
    if (input.stage !== 'DEPOSIT' && (!acceptance || !sameRef(acceptance.payload.contractRef, ref) || !currentSource(acceptance.payload.sourceReference, now) || at(acceptance.payload.acceptedAt) > now || at(acceptance.payload.acceptedAt) < at(signature.payload.signedAt))) return evaluation(null, ['COMMERCE_APPLICABLE_CUSTOMER_ACCEPTANCE_REQUIRED']);
    if (acceptance && !sameRef(acceptance.payload.contractRef, ref)) return evaluation(null, ['COMMERCE_ACCEPTANCE_BINDING_DENIED']);
    const selected = z.array(z.uuid()).min(1).max(36).parse(input.installmentIds);
    const schedule = c.paymentTerms.installments;
    if (new Set(selected).size !== selected.length || selected.some(id => !schedule.some(row => row.installmentId === id && row.kind === input.stage))) return evaluation(null, ['COMMERCE_INSTALLMENT_SELECTION_DENIED']);
    let assignedNet = 0, assignedTax = 0;
    const amounts = schedule.map((row, index) => {
      const last = index === schedule.length - 1;
      const netMinor = last ? c.financial.netMinor - assignedNet : safe(BigInt(c.financial.netMinor) * BigInt(row.percentageBps) / bps);
      const taxMinor = last ? c.financial.taxMinor - assignedTax : safe(BigInt(c.financial.taxMinor) * BigInt(row.percentageBps) / bps);
      assignedNet += netMinor; assignedTax += taxMinor; return { row, netMinor, taxMinor, amountMinor: sum([netMinor, taxMinor]) };
    }).filter(item => selected.includes(item.row.installmentId));
    const installments = amounts.map(({ row, amountMinor }) => {
      const anchor = row.anchor === 'CONTRACT_SIGNED' ? signature.payload.signedAt : acceptance?.payload.acceptedAt;
      if (!anchor) throw new Error('COMMERCE_INSTALLMENT_ANCHOR_MISSING');
      return { installmentId: row.installmentId, label: row.label, kind: row.kind, amountMinor, dueAt: new Date(at(anchor) + row.dueOffsetDays * 86_400_000).toISOString() };
    });
    return evaluation(commerceInvoiceRequestSchema.parse({ contractRef: ref, deliveryAcceptanceRef: input.stage === 'DEPOSIT' ? null : acceptance ? commerceRecordReference(acceptance) : null,
      stage: input.stage, paymentScheduleDigest: commerceDigest(c.paymentTerms), accountingEntityReference: p.accountingEntityReference,
      financial: { ...c.financial, netMinor: sum(amounts.map(row => row.netMinor)), taxMinor: sum(amounts.map(row => row.taxMinor)), grossMinor: sum(amounts.map(row => row.amountMinor)) },
      installments, status: 'DRAFT_REQUEST', accountingInvoiceSourceEventId: null }));
  });
}

export interface CommerceInvoicePosition { invoiceSourceEventId: string; currency: string; grossMinor: number; creditMinor: number; paidMinor: number; refundedMinor: number; outstandingMinor: number; creditAllocationKnown: boolean; installments: { installmentId: string; amountMinor: number; paidMinor: number; refundedMinor: number; outstandingMinor: number | null }[] }
export interface CommerceFinancialProjection { complete: boolean; accountingLedger: false; forecast: null; invoices: CommerceInvoicePosition[]; currencies: { currency: string; invoicedMinor: number; creditedMinor: number; settledPaymentMinor: number; settledRefundMinor: number; unallocatedAdvanceMinor: number; outstandingMinor: number }[]; excludedOperatorEventIds: string[]; activeSourceEventIds: string[] }
/** Pure projection of authenticated source snapshots. It never verifies a provider or issues a ledger entry. */
export function reconcileWebsiteSalesCommerceSources(input: { identity: CommerceIdentity; workflowId: string; events: SourceEvent[]; historyComplete?: boolean }, nowISO: string): CommerceEvaluation<CommerceFinancialProjection> {
  return attempt<CommerceFinancialProjection>(() => {
    const now = at(nowISO), reasons: string[] = [], events = z.array(websiteSalesCommerceSourceEventSchema).max(1000).parse(input.events).map(event => validEvent(event, input, now));
    if (input.historyComplete === false) reasons.push('COMMERCE_FINANCIAL_HISTORY_LIMITED');
    if (!events.some(event => ['INVOICE', 'PAYMENT', 'REFUND', 'CREDIT_NOTE'].includes(event.kind))) reasons.push('COMMERCE_FINANCIAL_SOURCE_REQUIRED');
    const ids = new Map<string, SourceEvent>(), aliases = new Map<string, string>(), resources = new Map<string, SourceEvent[]>(), versions = new Map<string, SourceEvent>();
    const sourceKey = (e: SourceEvent) => commerceDigest({ system: e.source.system, provider: e.source.provider, accountReference: e.source.accountReference, resourceType: e.source.resourceType, resourceId: e.source.resourceId });
    const semantic = (e: SourceEvent) => commerceDigest({ source: e.source, kind: e.kind, payload: e.payload, occurredAt: e.occurredAt, supersedesEventId: e.supersedesEventId, confidence: e.confidence });
    for (const event of [...events].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
      const previous = ids.get(event.eventId);
      if (previous && semantic(previous) !== semantic(event)) throw new Error('COMMERCE_SOURCE_EVENT_ID_CONFLICT');
      if (previous) continue;
      ids.set(event.eventId, event);
      const key = `${sourceKey(event)}:${event.source.version}`, existing = versions.get(key);
      if (existing) {
        if (semantic(existing) !== semantic(event)) throw new Error('COMMERCE_SOURCE_VERSION_FORK');
        aliases.set(event.eventId, existing.eventId); continue;
      }
      versions.set(key, event); resources.set(sourceKey(event), [...(resources.get(sourceKey(event)) ?? []), event]);
    }
    const resolveId = (id: string) => aliases.get(id) ?? id;
    const resolve = (id: string) => ids.get(resolveId(id));
    const latest: SourceEvent[] = [];
    for (const rows of resources.values()) {
      rows.sort((a, b) => a.source.version - b.source.version);
      for (const [index, row] of rows.entries()) {
        if (row.supersedesEventId) {
          const previous = resolve(row.supersedesEventId);
          if (!previous) reasons.push('COMMERCE_SOURCE_PREDECESSOR_MISSING');
          else if (sourceKey(previous) !== sourceKey(row) || previous.source.version >= row.source.version) throw new Error('COMMERCE_SOURCE_PREDECESSOR_CONFLICT');
        }
        const previous = rows[index - 1];
        if (previous && previous.kind !== row.kind) throw new Error('COMMERCE_SOURCE_KIND_CHANGED');
        if (previous && (previous.kind === 'PAYMENT' || previous.kind === 'REFUND') && (row.kind === 'PAYMENT' || row.kind === 'REFUND') && previous.payload.status === 'SETTLED' && row.payload.status !== 'SETTLED') reasons.push('COMMERCE_SETTLEMENT_CORRECTION_REQUIRES_REVERSAL');
      }
      const last = rows[rows.length - 1]; if (last) latest.push(last);
    }
    const reversalByTarget = new Map<string, SourceEvent[]>();
    for (const event of latest) if (event.kind === 'REVERSAL') {
      if (event.confidence !== 'PROVIDER_VERIFIED' || !['ACCOUNTING', 'PAYMENT_PROVIDER'].includes(event.source.system)) { reasons.push('COMMERCE_REVERSAL_AUTHORITY_REQUIRED'); continue; }
      const target = resolve(event.payload.reversesEventId);
      if (!target) { reasons.push('COMMERCE_REVERSAL_TARGET_MISSING'); continue; }
      if (commerceSourceFactDigest(target) !== event.payload.reversedEventDigest) throw new Error('COMMERCE_REVERSAL_DIGEST_MISMATCH');
      if (target.confidence !== 'PROVIDER_VERIFIED' || target.source.system !== event.source.system || target.source.provider !== event.source.provider || target.source.accountReference !== event.source.accountReference || at(event.occurredAt) < at(target.occurredAt)) throw new Error('COMMERCE_REVERSAL_SOURCE_DENIED');
      if (!latest.some(row => row.eventId === target.eventId)) reasons.push('COMMERCE_REVERSAL_OLDER_VERSION_REQUIRES_RECONCILIATION');
      const key = resolveId(target.eventId); reversalByTarget.set(key, [...(reversalByTarget.get(key) ?? []), event]);
    }
    const disabled = new Map<string, boolean>();
    function isReversed(id: string, stack = new Set<string>()): boolean {
      const key = resolveId(id), cached = disabled.get(key); if (cached !== undefined) return cached;
      if (stack.has(key)) throw new Error('COMMERCE_REVERSAL_CYCLE');
      const next = new Set(stack).add(key), active = (reversalByTarget.get(key) ?? []).filter(row => !isReversed(row.eventId, next));
      if (active.length > 1) throw new Error('COMMERCE_REVERSAL_DUPLICATE');
      const result = active.length === 1; disabled.set(key, result); return result;
    }
    for (const event of latest) isReversed(event.eventId);
    const active = latest.filter(event => !isReversed(event.eventId)), excludedOperatorEventIds = active.filter(event => event.confidence === 'OPERATOR_RECORDED').map(event => event.eventId);
    const trusted = active.filter(event => event.confidence === 'PROVIDER_VERIFIED');
    type Position = CommerceInvoicePosition & { event: Extract<SourceEvent, { kind: 'INVOICE' }> };
    const positions = new Map<string, Position>();
    for (const event of trusted) if (event.kind === 'INVOICE') {
      if (event.source.system !== 'ACCOUNTING') throw new Error('COMMERCE_ACCOUNTING_INVOICE_AUTHORITY_REQUIRED');
      if (event.payload.status !== 'ISSUED') continue;
      if (sum(event.payload.installments.map(row => row.amountMinor)) !== event.payload.financial.grossMinor || new Set(event.payload.installments.map(row => row.installmentId)).size !== event.payload.installments.length) throw new Error('COMMERCE_INVOICE_SCHEDULE_TOTAL_MISMATCH');
      positions.set(event.eventId, { event, invoiceSourceEventId: event.eventId, currency: event.payload.financial.currency, grossMinor: event.payload.financial.grossMinor, creditMinor: 0, paidMinor: 0, refundedMinor: 0, outstandingMinor: event.payload.financial.grossMinor, creditAllocationKnown: true,
        installments: event.payload.installments.map(row => ({ installmentId: row.installmentId, amountMinor: row.amountMinor, paidMinor: 0, refundedMinor: 0, outstandingMinor: row.amountMinor })) });
    }
    const invoicePosition = (id: string) => { const original = resolve(id); return original ? positions.get(resolveId(id)) ?? positions.get(latest.find(row => sourceKey(row) === sourceKey(original))?.eventId ?? '') : undefined; };
    const payments = new Map<string, Extract<SourceEvent, { kind: 'PAYMENT' }>>(), paidAllocations = new Map<string, number>(), refundedAllocations = new Map<string, number>(), refundsByPayment = new Map<string, number>(), unallocatedRefundByPayment = new Map<string, number>();
    const totals = new Map<string, { currency: string; invoicedMinor: number; creditedMinor: number; settledPaymentMinor: number; settledRefundMinor: number; unallocatedAdvanceMinor: number; outstandingMinor: number }>();
    const total = (currency: string) => { let row = totals.get(currency); if (!row) { row = { currency, invoicedMinor: 0, creditedMinor: 0, settledPaymentMinor: 0, settledRefundMinor: 0, unallocatedAdvanceMinor: 0, outstandingMinor: 0 }; totals.set(currency, row); } return row; };
    function allocationKey(paymentId: string, invoiceId: string, installmentId: string) { return `${paymentId}:${invoiceId}:${installmentId}`; }
    for (const event of trusted) if (event.kind === 'PAYMENT' && event.payload.status === 'SETTLED') {
      if (!['ACCOUNTING', 'PAYMENT_PROVIDER'].includes(event.source.system)) throw new Error('COMMERCE_PAYMENT_AUTHORITY_REQUIRED');
      const allocated = sum(event.payload.allocations.map(row => row.amountMinor)); if (allocated > event.payload.amountMinor) throw new Error('COMMERCE_PAYMENT_OVERALLOCATED');
      payments.set(event.eventId, event); const t = total(event.payload.currency); t.settledPaymentMinor = sum([t.settledPaymentMinor, event.payload.amountMinor]); t.unallocatedAdvanceMinor = sum([t.unallocatedAdvanceMinor, event.payload.amountMinor - allocated]);
      for (const item of event.payload.allocations) {
        const invoice = invoicePosition(item.invoiceSourceEventId), installment = invoice?.installments.find(row => row.installmentId === item.installmentId);
        if (!invoice || !installment) { reasons.push('COMMERCE_PAYMENT_INVOICE_OR_INSTALLMENT_MISSING'); continue; }
        if (invoice.currency !== event.payload.currency) throw new Error('COMMERCE_ALLOCATION_CURRENCY_MISMATCH');
        installment.paidMinor = sum([installment.paidMinor, item.amountMinor]); invoice.paidMinor = sum([invoice.paidMinor, item.amountMinor]);
        const key = allocationKey(event.eventId, invoice.invoiceSourceEventId, item.installmentId); paidAllocations.set(key, sum([paidAllocations.get(key) ?? 0, item.amountMinor]));
      }
    }
    for (const event of trusted) if (event.kind === 'REFUND' && event.payload.status === 'SETTLED') {
      if (!['ACCOUNTING', 'PAYMENT_PROVIDER'].includes(event.source.system)) throw new Error('COMMERCE_REFUND_AUTHORITY_REQUIRED');
      const original = resolve(event.payload.paymentSourceEventId), payment = original ? payments.get(resolveId(original.eventId)) ?? payments.get(latest.find(row => sourceKey(row) === sourceKey(original))?.eventId ?? '') : undefined;
      if (!payment) { reasons.push('COMMERCE_REFUND_PAYMENT_MISSING'); continue; }
      if (payment.payload.currency !== event.payload.currency) throw new Error('COMMERCE_REFUND_CURRENCY_MISMATCH');
      const amount = sum([refundsByPayment.get(payment.eventId) ?? 0, event.payload.amountMinor]); refundsByPayment.set(payment.eventId, amount);
      if (amount > payment.payload.amountMinor) throw new Error('COMMERCE_REFUND_EXCEEDS_PAYMENT');
      const allocated = sum(event.payload.allocations.map(row => row.amountMinor)); if (allocated > event.payload.amountMinor) throw new Error('COMMERCE_REFUND_OVERALLOCATED');
      const t = total(event.payload.currency); t.settledRefundMinor = sum([t.settledRefundMinor, event.payload.amountMinor]);
      const unallocatedRefund = event.payload.amountMinor - allocated;
      const paymentUnallocated = payment.payload.amountMinor - sum(payment.payload.allocations.map(row => row.amountMinor));
      const cumulativeUnallocatedRefund = sum([unallocatedRefundByPayment.get(payment.eventId) ?? 0, unallocatedRefund]);
      if (cumulativeUnallocatedRefund > paymentUnallocated || unallocatedRefund > t.unallocatedAdvanceMinor) throw new Error('COMMERCE_REFUND_UNALLOCATED_EXCEEDS_ADVANCE');
      unallocatedRefundByPayment.set(payment.eventId, cumulativeUnallocatedRefund);
      t.unallocatedAdvanceMinor -= unallocatedRefund;
      for (const item of event.payload.allocations) {
        const invoice = invoicePosition(item.invoiceSourceEventId), installment = invoice?.installments.find(row => row.installmentId === item.installmentId);
        if (!invoice || !installment) { reasons.push('COMMERCE_REFUND_INVOICE_OR_INSTALLMENT_MISSING'); continue; }
        const key = allocationKey(payment.eventId, invoice.invoiceSourceEventId, item.installmentId), refunded = sum([refundedAllocations.get(key) ?? 0, item.amountMinor]);
        if (refunded > (paidAllocations.get(key) ?? 0)) throw new Error('COMMERCE_REFUND_EXCEEDS_ALLOCATION');
        refundedAllocations.set(key, refunded); installment.refundedMinor = sum([installment.refundedMinor, item.amountMinor]); invoice.refundedMinor = sum([invoice.refundedMinor, item.amountMinor]);
      }
    }
    for (const event of trusted) if (event.kind === 'CREDIT_NOTE' && event.payload.status === 'ISSUED') {
      if (event.source.system !== 'ACCOUNTING') throw new Error('COMMERCE_ACCOUNTING_CREDIT_AUTHORITY_REQUIRED');
      const invoice = invoicePosition(event.payload.invoiceSourceEventId);
      if (!invoice) { reasons.push('COMMERCE_CREDIT_INVOICE_MISSING'); continue; }
      if (invoice.currency !== event.payload.currency) throw new Error('COMMERCE_CREDIT_CURRENCY_MISMATCH');
      invoice.creditMinor = sum([invoice.creditMinor, event.payload.amountMinor]); if (invoice.creditMinor > invoice.grossMinor) throw new Error('COMMERCE_CREDIT_EXCEEDS_INVOICE');
    }
    const invoices = [...positions.values()].map(({ event: ignored, ...invoice }) => {
      void ignored;
      for (const installment of invoice.installments) {
        if (installment.paidMinor - installment.refundedMinor > installment.amountMinor) reasons.push('COMMERCE_INVOICE_OVERPAYMENT_REQUIRES_RECONCILIATION');
        // A credit note without installment allocation cannot invent which due date was relieved.
        installment.outstandingMinor = invoice.creditMinor ? null : Math.max(0, installment.amountMinor - installment.paidMinor + installment.refundedMinor);
      }
      invoice.creditAllocationKnown = invoice.creditMinor === 0;
      invoice.outstandingMinor = Math.max(0, invoice.grossMinor - invoice.creditMinor - invoice.paidMinor + invoice.refundedMinor);
      if (invoice.paidMinor - invoice.refundedMinor > invoice.grossMinor - invoice.creditMinor) reasons.push('COMMERCE_INVOICE_OVERPAYMENT_REQUIRES_RECONCILIATION');
      const t = total(invoice.currency); t.invoicedMinor = sum([t.invoicedMinor, invoice.grossMinor]); t.creditedMinor = sum([t.creditedMinor, invoice.creditMinor]); t.outstandingMinor = sum([t.outstandingMinor, invoice.outstandingMinor]); return invoice;
    });
    if (excludedOperatorEventIds.some(id => { const e = ids.get(id); return e && ['INVOICE', 'PAYMENT', 'REFUND', 'CREDIT_NOTE', 'REVERSAL'].includes(e.kind); })) reasons.push('COMMERCE_OPERATOR_FINANCIAL_SOURCE_UNVERIFIED');
    return evaluation({ complete: reasons.length === 0, accountingLedger: false, forecast: null, invoices, currencies: [...totals.values()], excludedOperatorEventIds, activeSourceEventIds: active.map(row => row.eventId) }, reasons, true);
  });
}

/** Calendar anniversaries preserve the original service start, including month-end starts. */
export function websiteSalesServiceMonth(startAt: string, atISO: string): number {
  const start = new Date(at(startAt)), current = new Date(at(atISO)); if (current < start) throw new Error('COMMERCE_SERVICE_NOT_STARTED');
  let months = (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + current.getUTCMonth() - start.getUTCMonth();
  const anniversary = new Date(start.getTime()); anniversary.setUTCDate(1); anniversary.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(anniversary.getUTCFullYear(), anniversary.getUTCMonth() + 1, 0)).getUTCDate(); anniversary.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  if (current < anniversary) months--; return months + 1;
}
export interface CommerceRenewalProposal { subscriptionRef: CommerceReference; originalServiceStartAt: string; reviewAt: string; serviceMonth: number; planKey: 'MANAGED' | 'PERFORMANCE' | 'CONVERSION'; currency: 'EUR'; amountMinor: number; termsDigest: string; authoritativeSourceEventId: string; automaticRenewal: false; createsInvoice: false }
export function proposeWebsiteSalesRenewal(input: { subscription: CommerceRecord<z.infer<typeof commerceSubscriptionTermsSchema>>; source: SubscriptionEvent; sourceEvents: SourceEvent[]; historyComplete?: boolean; reviewAt: string }, ctx: CommerceContext, nowISO: string): CommerceEvaluation<CommerceRenewalProposal> {
  return attempt<CommerceRenewalProposal>(() => {
    const now = at(nowISO), subscription = record(input.subscription, commerceSubscriptionTermsSchema, ctx, now), source = validEvent(input.source, ctx, now), authored = subscription.payload;
    const current = resolveWebsiteSalesCommerceSubscription({ identity: ctx.identity, workflowId: ctx.workflowId, events: input.sourceEvents, terms: authored,
      ...(input.historyComplete === undefined ? {} : { historyComplete: input.historyComplete }) }, nowISO);
    if (current.status !== 'READY' || !current.value) return evaluation(null, current.reasons, current.status === 'NEEDS_RECONCILIATION');
    if (commerceSourceFactDigest(source) !== commerceSourceFactDigest(current.value)) return evaluation(null, ['COMMERCE_SUBSCRIPTION_NOT_CURRENT']);
    if (source.kind !== 'SUBSCRIPTION' || source.confidence !== 'PROVIDER_VERIFIED' || !['SERVICE_AUTHORITY', 'ACCOUNTING'].includes(source.source.system)) return evaluation(null, ['COMMERCE_AUTHORITATIVE_SUBSCRIPTION_SOURCE_REQUIRED']);
    const s = source.payload;
    if (!sameRef(s.contractRef, authored.contractRef) || s.termsDigest !== authored.termsDigest || s.planKey !== authored.planKey || s.originalServiceStartAt !== authored.originalServiceStartAt || s.currency !== 'EUR') return evaluation(null, ['COMMERCE_SUBSCRIPTION_TERMS_BINDING_DENIED']);
    if (!currentSource(s.sourceReference, now) || !['ACTIVE', 'PAUSED'].includes(s.status) || at(s.periodEndAt) <= at(s.periodStartAt) || at(s.periodStartAt) < at(s.originalServiceStartAt)) return evaluation(null, ['COMMERCE_CURRENT_SUBSCRIPTION_TERMS_REQUIRED']);
    if (s.cancellationEffectiveAt && at(input.reviewAt) >= at(s.cancellationEffectiveAt)) return evaluation(null, ['COMMERCE_SUBSCRIPTION_CANCELLATION_EFFECTIVE']);
    const serviceMonth = websiteSalesServiceMonth(s.originalServiceStartAt, input.reviewAt);
    return evaluation({ subscriptionRef: commerceRecordReference(subscription), originalServiceStartAt: s.originalServiceStartAt, reviewAt: input.reviewAt, serviceMonth, planKey: s.planKey, currency: 'EUR', amountMinor: s.planKey === 'MANAGED' ? serviceMonth >= 13 ? 9900 : 3900 : s.planKey === 'PERFORMANCE' ? 14900 : 22900,
      termsDigest: s.termsDigest, authoritativeSourceEventId: source.eventId, automaticRenewal: false, createsInvoice: false });
  });
}
