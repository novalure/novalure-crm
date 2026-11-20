import { createHash } from 'node:crypto';
import { z } from 'zod';

export const websiteSalesOperationsContract = 'website-sales-operations-v1' as const;
export const opsUuid = z.uuid().transform(value => value.toLowerCase());
export const opsHash = z.hash('sha256');
export const opsTime = z.iso.datetime({ offset: true });
export const opsText = z.string().trim().min(1).max(500);
export const opsMoney = z.number().int().nonnegative().safe();
export const opsBps = z.number().int().min(0).max(10_000);
export const operationsScopeSchema = z.strictObject({ workspaceId: opsUuid, projectId: opsUuid });
export const operationsIdentitySchema = operationsScopeSchema.extend({ companyId: opsUuid, locationId: opsUuid });
export const operationsRevisionSchema = z.strictObject({ version: z.number().int().positive().max(1_000_000), previousDigest: opsHash.nullable() })
  .refine(value => value.version === 1 ? value.previousDigest === null : value.previousDigest !== null, 'REVISION_PREDECESSOR_REQUIRED');
export const operationsApprovalSchema = z.strictObject({ approvalId: opsUuid, approvedBy: opsUuid, approvedAt: opsTime, validUntil: opsTime, contentDigest: opsHash });
export const operationsOriginSchema = z.strictObject({ identity: operationsIdentitySchema, opportunityId: opsUuid, cohortAssignmentId: opsUuid, attributionDigest: opsHash });
export const operationsBindingSchema = operationsOriginSchema.extend({ workflowId: opsUuid, workflowVersion: z.number().int().positive().safe(),
  recordVersion: z.number().int().positive().safe(), evidenceDigest: opsHash, observedAt: opsTime, validUntil: opsTime })
  .refine(value => value.opportunityId === value.workflowId, 'V1_OPPORTUNITY_EQUALS_WORKFLOW');
const signalKind = z.enum(['FIT', 'NEED', 'INTENT', 'URGENCY', 'ENGAGEMENT']);
export const operationsSignalSchema = z.strictObject({ kind: signalKind, value: z.number().int().min(0).max(100),
  origin: operationsOriginSchema, sourceId: opsUuid, sourceDigest: opsHash, observedAt: opsTime, validUntil: opsTime });
const policyBase = { policyId: opsUuid, scope: operationsScopeSchema, revision: operationsRevisionSchema, enabled: z.boolean(),
  validFrom: opsTime, validUntil: opsTime, approval: operationsApprovalSchema.nullable() };
export const portfolioPolicySchema = z.strictObject({ ...policyBase,
  maxOpportunities: z.number().int().min(0).max(200), maxPerCompany: z.number().int().min(0).max(200),
  maxCostPerOpportunityMinor: opsMoney, maxMinutesPerOpportunity: z.number().int().nonnegative().safe(),
  minimumKnownSignals: z.number().int().min(1).max(5), minimumScore: z.number().int().min(0).max(100),
  weights: z.strictObject({ FIT: opsBps, NEED: opsBps, INTENT: opsBps, URGENCY: opsBps, ENGAGEMENT: opsBps }) });
export const portfolioCandidateSchema = z.strictObject({ binding: operationsBindingSchema,
  status: z.enum(['OPEN', 'QUALIFIED', 'OFFER_DRAFT', 'WON', 'LOST', 'STOPPED', 'NURTURE']),
  purpose: z.enum(['INTERNAL_RESEARCH', 'NEW_CUSTOMER_DIALOG', 'OUTREACH']), dialogSourceId: opsUuid.nullable(),
  stopReason: z.enum(['REPLY_RECEIVED', 'OPT_OUT', 'UNKNOWN_DELIVERY', 'IDENTITY_AMBIGUOUS', 'STALE_EVIDENCE', 'NO_FIT', 'OTHER']).nullable(),
  qualificationStatus: z.enum(['READY', 'NEEDS_CLARIFICATION', 'NURTURE']),
  requestedStage: z.enum(['DIAGNOSIS', 'CONCEPT', 'CONCEPT_ACCEPTANCE', 'DEMO', 'CONVERSATION']), estimatedCostMinor: opsMoney,
  requiredMinutes: z.number().int().positive().safe(), signals: z.array(operationsSignalSchema).max(5), assetRightsReference: opsUuid.nullable(),
  stagePrerequisite: z.strictObject({ stage: z.enum(['DIAGNOSIS', 'CONCEPT']), artifactId: opsUuid, artifactDigest: opsHash,
    evidenceDigest: opsHash, completedAt: opsTime, acceptedAt: opsTime.nullable() }).nullable() });
export const portfolioResourcesSchema = z.strictObject({ budgetId: opsUuid, budgetVersion: z.number().int().positive().safe(),
  capacityId: opsUuid, capacityVersion: z.number().int().positive().safe(), availableBudgetMinor: opsMoney,
  availableMinutes: z.number().int().nonnegative().safe(), observedAt: opsTime, validUntil: opsTime });
export const portfolioInputSchema = z.strictObject({ scope: operationsScopeSchema, revision: operationsRevisionSchema,
  policy: portfolioPolicySchema, resources: portfolioResourcesSchema, candidates: z.array(portfolioCandidateSchema).max(200) });
export const pricingPolicySchema = z.strictObject({ ...policyBase, currency: z.literal('EUR'),
  products: z.array(z.strictObject({ sku: opsText, unitNetPriceMinor: opsMoney, minimumUnitNetPriceMinor: opsMoney,
    maxDiscountBps: opsBps })).min(1).max(30), minimumMarginBps: opsBps, maximumNegotiationRounds: z.number().int().min(1).max(100),
  maxQuoteAgeMinutes: z.number().int().min(1).max(43_200), negotiationStepBps: opsBps, maximumCounteroffers: z.number().int().min(0).max(100) });
export const pricingTermsSchema = z.strictObject({ scopeDigest: opsHash, offerId: opsUuid, offerVersion: z.number().int().positive().safe(), offerDigest: opsHash,
  contractId: opsUuid.nullable(), contractVersion: z.number().int().positive().safe().nullable(), contractDigest: opsHash.nullable(),
  contractStatus: z.enum(['DRAFT', 'SIGNED']).nullable() }).refine(value => [value.contractId, value.contractVersion, value.contractDigest, value.contractStatus]
    .every(item => item === null) || [value.contractId, value.contractVersion, value.contractDigest, value.contractStatus].every(item => item !== null), 'CONTRACT_BINDING_INCOMPLETE');
const quoteLine = z.strictObject({ sku: opsText, quantity: z.number().int().min(1).max(1_000), listNetMinor: opsMoney, discountMinor: opsMoney, netMinor: opsMoney });
export const pricingProposalSchema = z.strictObject({ contractVersion: z.literal(websiteSalesOperationsContract), kind: z.literal('PRICE_PROPOSAL'),
  scope: operationsScopeSchema, revision: operationsRevisionSchema, binding: operationsBindingSchema, terms: pricingTermsSchema, termsDigest: opsHash,
  policyId: opsUuid, policyVersion: z.number().int().positive().safe(), policyDigest: opsHash, negotiationRound: z.number().int().min(1).max(100),
  mode: z.enum(['INITIAL', 'REQUESTED_DISCOUNT', 'AUTO_COUNTEROFFER']), counteroffers: z.number().int().min(0).max(100), previousQuoteDigest: opsHash.nullable(),
  requestedDiscountBps: opsBps, lines: z.array(quoteLine).min(1).max(30), currency: z.literal('EUR'), listNetMinor: opsMoney, discountMinor: opsMoney,
  netMinor: opsMoney, estimatedDeliveryCostMinor: opsMoney.nullable(), estimatedMarginBps: z.number().int().safe().nullable(), createdAt: opsTime, validUntil: opsTime,
  status: z.enum(['BLOCKED', 'WITHIN_RULES_REQUIRES_OFFER_APPROVAL']), reasons: z.array(opsText).max(100), requiresFinalOfferApproval: z.literal(true),
  requiresContractApproval: z.literal(true), offerApprovalInvalidationRequired: z.literal(true), bindingPriceAuthorized: z.literal(false), externalEffectAllowed: z.literal(false), proposalDigest: opsHash });
export const pricingInputSchema = z.strictObject({ scope: operationsScopeSchema, revision: operationsRevisionSchema, binding: operationsBindingSchema,
  policy: pricingPolicySchema, terms: pricingTermsSchema, lines: z.array(z.strictObject({ sku: opsText, quantity: z.number().int().min(1).max(1_000) })).min(1).max(30),
  requestedDiscountBps: opsBps, estimatedDeliveryCostMinor: opsMoney.nullable(), negotiationRound: z.number().int().min(1).max(100),
  previousQuoteDigest: opsHash.nullable(), mode: z.enum(['INITIAL', 'REQUESTED_DISCOUNT', 'AUTO_COUNTEROFFER']), priorProposal: pricingProposalSchema.nullable(),
  priorApplication: z.strictObject({ quoteDigest: opsHash, offerId: opsUuid, offerVersion: z.number().int().positive().safe(), offerDigest: opsHash, appliedAt: opsTime }).nullable() });
export const outcomeKindSchema = z.enum(['PAYMENT', 'ADVANCE_RECEIVED', 'ADVANCE_APPLIED', 'REFUND', 'COST', 'COST_REVERSAL', 'OBLIGATION', 'OBLIGATION_RELEASE',
  'NO_RESPONSE', 'ABANDONED', 'FULFILLED', 'PAYMENTS_COMPLETE', 'COSTS_COMPLETE']);
/** Hydrated by the CRM from immutable source rows. Machine commands submit sourceId+sourceDigest, never amounts. */
export const outcomeSourceSchema = z.strictObject({ sourceId: opsUuid, sourceSystem: z.enum(['ACCOUNTING', 'BANK', 'APPROVED_MANUAL', 'CRM']),
  recordId: opsText, economicEventId: opsUuid, recordVersion: z.number().int().positive().safe(), previousSourceDigest: opsHash.nullable(), supersedesSourceId: opsUuid.nullable(),
  sourceConfidence: z.enum(['OPERATOR_RECORDED_FINANCIAL_DOCUMENT', 'CRM_CANONICAL_EVENT']),
  origin: operationsOriginSchema, kind: outcomeKindSchema, currency: z.literal('EUR'), amountMinor: opsMoney.nullable(),
  occurredAt: opsTime, observedAt: opsTime, relatedSourceId: opsUuid.nullable(), approvalReference: opsUuid.nullable(),
  basis: z.enum(['SETTLED_ACTUAL', 'APPROVED_COMMITMENT', 'CRM_OBSERVATION']), sourceDigest: opsHash });
export const outcomeEventSchema = z.strictObject({ eventId: opsUuid, source: outcomeSourceSchema });
export const outcomeCohortSchema = z.strictObject({ scope: operationsScopeSchema, revision: operationsRevisionSchema,
  origins: z.array(operationsOriginSchema.extend({ enteredAt: opsTime })).min(1).max(500), events: z.array(outcomeEventSchema).max(5_000) });
export const improvementRuleSchema = z.strictObject({ ...policyBase, minimumCompletedSamples: z.number().int().min(1).max(500),
  minimumCoverageBps: opsBps,
  permittedField: z.enum(['MAX_DISCOUNT_BPS', 'MIN_MARGIN_BPS', 'MAX_OPPORTUNITY_COST_MINOR']),
  currentValue: opsMoney, minimumValue: opsMoney, maximumValue: opsMoney, maximumAbsoluteChange: opsMoney });
export const improvementInputSchema = z.strictObject({ scope: operationsScopeSchema, revision: operationsRevisionSchema,
  rule: improvementRuleSchema, cohort: outcomeCohortSchema, proposedValue: opsMoney });
export type OperationsScope = z.infer<typeof operationsScopeSchema>;
export type OperationsBinding = z.infer<typeof operationsBindingSchema>;
export type OperationsOrigin = z.infer<typeof operationsOriginSchema>;
export type PortfolioInput = z.infer<typeof portfolioInputSchema>;
export type PricingInput = z.infer<typeof pricingInputSchema>;
export type OutcomeCohort = z.infer<typeof outcomeCohortSchema>;
export type OutcomeSource = z.infer<typeof outcomeSourceSchema>;
export type ImprovementInput = z.infer<typeof improvementInputSchema>;
export class WebsiteSalesOperationsError extends Error { constructor(readonly code: string) { super(code); this.name = 'WebsiteSalesOperationsError'; } }
export function operationsFail(code: string): never { throw new WebsiteSalesOperationsError(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function websiteSalesOperationsDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function operationsImmutable<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(operationsImmutable); Object.freeze(value); } return value; }
export function operationsScopeEqual(a: OperationsScope, b: OperationsScope): boolean { return a.workspaceId === b.workspaceId && a.projectId === b.projectId; }
export function operationsCurrent(observedAt: string, validUntil: string, now: string): boolean {
  return Date.parse(observedAt) <= Date.parse(now) && Date.parse(now) < Date.parse(validUntil);
}
export function operationsSafe(value: bigint): number { const result = Number(value); if (!Number.isSafeInteger(result)) operationsFail('OPERATIONS_UNSAFE_MONEY_SUM'); return result; }
export function websiteSalesPolicyDigest(policy: { approval: unknown }): string { const { approval, ...unsigned } = policy; void approval; return websiteSalesOperationsDigest(unsigned); }
export function operationsPolicyReasons(policy: z.infer<typeof portfolioPolicySchema> | z.infer<typeof pricingPolicySchema> | z.infer<typeof improvementRuleSchema>, scope: OperationsScope, now: string): string[] {
  const reasons: string[] = [];
  if (!operationsScopeEqual(policy.scope, scope)) operationsFail('OPERATIONS_POLICY_SCOPE_MISMATCH');
  if (!policy.enabled) reasons.push('POLICY_INACTIVE');
  if (!operationsCurrent(policy.validFrom, policy.validUntil, now)) reasons.push('POLICY_NOT_CURRENT');
  if (!policy.approval || !operationsCurrent(policy.approval.approvedAt, policy.approval.validUntil, now)
    || policy.approval.contentDigest !== websiteSalesPolicyDigest(policy)) reasons.push('CURRENT_EXACT_POLICY_APPROVAL_REQUIRED');
  return reasons;
}
export function operationsBindingReasons(binding: OperationsBinding, scope: OperationsScope, now: string): string[] {
  if (!operationsScopeEqual(binding.identity, scope)) operationsFail('OPERATIONS_OPPORTUNITY_SCOPE_MISMATCH');
  return operationsCurrent(binding.observedAt, binding.validUntil, now) ? [] : ['CURRENT_CANONICAL_OPPORTUNITY_REQUIRED'];
}
