import { z } from 'zod';

/** Browser-safe wire data. Only authenticated canonical resolvers establish authority. */
export const websiteSalesCommerceContract = 'website-sales-commerce-v1' as const;
export const websiteSalesCommerceSourceContract = 'website-sales-commerce-source-v1' as const;
export const commerceUuid = z.uuid().transform(value => value.toLowerCase());
export const commerceHash = z.hash('sha256');
export const commerceTime = z.iso.datetime({ offset: true });
export const commerceText = z.string().trim().min(1).max(2_000).refine(value => !/\u0000|-----BEGIN.{0,40}PRIVATE KEY|\b(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\//i.test(value), 'COMMERCE_UNSAFE_TEXT');
const legalText = z.string().min(1).max(120_000).refine(value => value.trim().length > 0 && !/\u0000|-----BEGIN.{0,40}PRIVATE KEY|\b(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\//i.test(value), 'COMMERCE_UNSAFE_TEXT');
export const commerceExternalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
export const commerceMinor = z.number().int().nonnegative().safe();
export const commerceCurrency = z.enum(['EUR', 'GBP', 'USD']);
export const commerceIdentitySchema = z.strictObject({ workspaceId: commerceUuid, projectId: commerceUuid, companyId: commerceUuid, locationId: commerceUuid.nullable() });
export const commerceReferenceSchema = z.strictObject({ id: commerceUuid, version: z.number().int().positive().safe(), digest: commerceHash });
export const commerceSourceReferenceSchema = z.strictObject({ reference: commerceText.max(500), digest: commerceHash, observedAt: commerceTime, validUntil: commerceTime });
export const commerceFinancialSnapshotSchema = z.strictObject({ currency: commerceCurrency, netMinor: commerceMinor, taxMinor: commerceMinor, grossMinor: commerceMinor,
  taxReference: commerceSourceReferenceSchema, termsDigest: commerceHash }).refine(value => Number.isSafeInteger(value.netMinor + value.taxMinor) && value.netMinor + value.taxMinor === value.grossMinor, 'COMMERCE_FINANCIAL_TOTAL_MISMATCH');
export const commerceTemplateSchema = z.strictObject({ title: commerceText.max(200), jurisdiction: commerceText.max(100), language: z.enum(['en', 'de']),
  content: legalText.max(100_000), contentSha256: commerceHash, allowedVariableKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(40),
  legalReviewReference: commerceSourceReferenceSchema, validUntil: commerceTime,
  providerMapping: z.strictObject({ provider: z.literal('DOCUSEAL'), templateId: z.number().int().positive().safe(), templateDigest: commerceHash,
    fieldMap: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), commerceText.max(100)) }).optional() });
export const commercePaymentTermsSchema = z.strictObject({ installments: z.array(z.strictObject({ installmentId: commerceUuid,
  label: commerceText.max(120), percentageBps: z.number().int().positive().max(10_000).optional(), fixedNetMinor: commerceMinor.refine(value => value > 0).optional(), dueOffsetDays: z.number().int().min(0).max(3650),
  anchor: z.enum(['CONTRACT_SIGNED', 'DELIVERY_ACCEPTED']), kind: z.enum(['DEPOSIT', 'MILESTONE', 'BALANCE', 'RECURRING']) })).min(1).max(36) }).refine(value => {
    const rows = value.installments, fixed = rows.every(row => row.fixedNetMinor !== undefined && row.percentageBps === undefined);
    const percentage = rows.every(row => row.percentageBps !== undefined && row.fixedNetMinor === undefined) && rows.reduce((sum, row) => sum + (row.percentageBps ?? 0), 0) === 10_000;
    return (fixed || percentage) && new Set(rows.map(row => row.installmentId)).size === rows.length && rows.every(row => row.kind === 'DEPOSIT' ? row.anchor === 'CONTRACT_SIGNED' : row.anchor === 'DELIVERY_ACCEPTED');
  }, 'COMMERCE_PAYMENT_TERMS_INVALID');
function fixedScheduleMatches(terms: z.infer<typeof commercePaymentTermsSchema>, netMinor: number) {
  return terms.installments[0]?.fixedNetMinor === undefined || terms.installments.reduce((total, row) => total + BigInt(row.fixedNetMinor ?? 0), BigInt(0)) === BigInt(netMinor);
}
export const commerceAccountingProfileSchema = z.strictObject({ issuerLegalName: commerceText.max(200), issuerAddress: commerceText.max(1000), taxIdentifier: commerceText.max(100).nullable(),
  currency: z.literal('EUR'), taxRateBps: z.number().int().min(0).max(100_000), rounding: z.literal('HALF_UP'), sourceReference: commerceSourceReferenceSchema });
/** A finite sourced obligation; catalog/CARE linkage is checked by the canonical CRM resolver. */
export const commerceContractTermSchema = z.strictObject({ startAt: commerceTime, endAt: commerceTime, fullNetMinor: commerceMinor, sourceReference: commerceSourceReferenceSchema })
  .refine(value => Number.isFinite(Date.parse(value.startAt)) && Number.isFinite(Date.parse(value.endAt)) && Date.parse(value.endAt) > Date.parse(value.startAt), 'COMMERCE_CONTRACT_TERM_INVALID');
export const commercePolicySchema = z.strictObject({ title: commerceText.max(200), standardTermsReference: commerceSourceReferenceSchema,
  standardTermsDigest: commerceHash, signatureAssurance: z.enum(['PROVIDER_ATTESTED', 'ADVANCED', 'QUALIFIED']), maxInstallments: z.number().int().min(1).max(36),
  accountingEntityReference: commerceText.max(200), accountingCustomerReference: commerceExternalId.optional(), accountingSourceReference: commerceSourceReferenceSchema, accountingProfile: commerceAccountingProfileSchema,
  offerRef: commerceReferenceSchema, financialSnapshot: commerceFinancialSnapshotSchema, paymentTerms: commercePaymentTermsSchema, contractTerm: commerceContractTermSchema.optional(), validUntil: commerceTime })
  .refine(value => !value.contractTerm || value.contractTerm.fullNetMinor === value.financialSnapshot.netMinor, 'COMMERCE_FULL_TERM_FINANCIAL_MISMATCH')
  .refine(value => fixedScheduleMatches(value.paymentTerms, value.financialSnapshot.netMinor), 'COMMERCE_FIXED_SCHEDULE_TOTAL_MISMATCH');
export const commerceOfferSchema = z.strictObject({ offerRef: commerceReferenceSchema, dealId: commerceUuid, status: z.enum(['DRAFT', 'APPROVED', 'QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED']),
  recipientEmail: z.email(), recipientDigest: commerceHash, scopeDigest: commerceHash, financial: commerceFinancialSnapshotSchema, approvalReference: commerceUuid.nullable() });
/** Canonical NET-only choice is available before a sourced tax/payment policy exists. */
export const commerceOfferChoiceSchema = z.strictObject({ identity: commerceIdentitySchema, workflowId: commerceUuid, offerRef: commerceReferenceSchema,
  dealId: commerceUuid, status: z.enum(['DRAFT', 'APPROVED', 'QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED']), recipientEmail: z.email(), recipientDigest: commerceHash,
  scopeDigest: commerceHash, totalNetMinor: commerceMinor, currency: z.literal('EUR'), taxBasis: z.literal('NET') });
export const commerceContractDraftSchema = z.strictObject({ offerRef: commerceReferenceSchema, templateRef: commerceReferenceSchema, policyRef: commerceReferenceSchema,
  title: commerceText.max(200), body: legalText, documentSha256: commerceHash, recipientEmail: z.email(), recipientDigest: commerceHash,
  financial: commerceFinancialSnapshotSchema, standardTerms: z.boolean(), status: z.enum(['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'QUEUED', 'DELIVERED', 'SIGNATURE_PENDING', 'SIGNED', 'DECLINED', 'EXPIRED', 'VOIDED']),
  paymentTerms: commercePaymentTermsSchema, contractTerm: commerceContractTermSchema.optional(), signatureSourceEventId: commerceUuid.nullable(), deliverySourceEventId: commerceUuid.nullable() })
  .refine(value => !value.contractTerm || value.contractTerm.fullNetMinor === value.financial.netMinor, 'COMMERCE_FULL_TERM_FINANCIAL_MISMATCH')
  .refine(value => fixedScheduleMatches(value.paymentTerms, value.financial.netMinor), 'COMMERCE_FIXED_SCHEDULE_TOTAL_MISMATCH');
export const commerceApprovalSchema = z.strictObject({ approvalId: commerceUuid, documentRef: commerceReferenceSchema, documentSha256: commerceHash,
  recipientDigest: commerceHash, financialDigest: commerceHash, requiredSteps: z.union([z.literal(1), z.literal(2)]), completedSteps: z.number().int().min(0).max(2),
  status: z.enum(['PENDING', 'APPROVED', 'REVOKED', 'EXPIRED', 'DENIED']), expiresAt: commerceTime,
  currentChallenge: z.strictObject({ challengeId: commerceUuid, stepNumber: z.union([z.literal(1), z.literal(2)]), expiresAt: commerceTime }).nullable() });
export const commerceInstallmentSchema = z.strictObject({ installmentId: commerceUuid, label: commerceText.max(120), amountMinor: commerceMinor, dueAt: commerceTime, kind: z.enum(['DEPOSIT', 'MILESTONE', 'BALANCE', 'RECURRING']) });
export const commerceInvoiceRequestSchema = z.strictObject({ contractRef: commerceReferenceSchema, deliveryAcceptanceRef: commerceReferenceSchema.nullable(),
  stage: z.enum(['DEPOSIT', 'MILESTONE', 'BALANCE', 'RECURRING']), paymentScheduleDigest: commerceHash,
  accountingEntityReference: commerceText.max(200), customerReference: commerceExternalId, financial: commerceFinancialSnapshotSchema, installments: z.array(commerceInstallmentSchema).min(1).max(36),
  status: z.enum(['DRAFT_REQUEST', 'REQUESTED', 'ISSUED', 'REJECTED', 'UNKNOWN']), accountingInvoiceSourceEventId: commerceUuid.nullable() });
export const commerceDeliveryAcceptanceSchema = z.strictObject({ contractRef: commerceReferenceSchema, canonicalDeliveryTaskId: commerceUuid, expectedDeliveryTaskVersion: z.number().int().positive().safe(),
  scopeDigest: commerceHash, sourceReference: commerceSourceReferenceSchema, acceptedAt: commerceTime });
export const commerceSubscriptionTermsSchema = z.strictObject({ contractRef: commerceReferenceSchema, planKey: z.enum(['MANAGED', 'PERFORMANCE', 'CONVERSION']),
  originalServiceStartAt: commerceTime, periodStartAt: commerceTime, periodEndAt: commerceTime, renewalAt: commerceTime.nullable(), cancellationEffectiveAt: commerceTime.nullable(),
  currency: commerceCurrency, termsDigest: commerceHash, sourceReference: commerceSourceReferenceSchema,
  status: z.enum(['PROPOSED', 'PENDING_SOURCE', 'ACTIVE', 'PAUSED', 'CANCEL_PENDING', 'CANCELLED', 'EXPIRED']), canonicalSourceEventId: commerceUuid.nullable() });
export function commerceRecordSchema<T extends z.ZodType>(payload: T) { return z.strictObject({ id: commerceUuid, identity: commerceIdentitySchema, workflowId: commerceUuid,
  version: z.number().int().positive().safe(), workflowVersion: z.number().int().positive().safe(), digest: commerceHash, createdBy: commerceUuid, createdAt: commerceTime,
  validUntil: commerceTime.nullable(), revokedAt: commerceTime.nullable(), payload }); }

export const commerceSourceBindingSchema = z.strictObject({ system: z.enum(['CRM', 'ACCOUNTING', 'PAYMENT_PROVIDER', 'SIGNATURE_PROVIDER', 'DELIVERY_PROVIDER', 'SERVICE_AUTHORITY', 'OPERATOR_RECORD']),
  provider: commerceText.max(100), accountReference: commerceText.max(200), resourceType: commerceText.max(100), resourceId: commerceExternalId,
  version: z.number().int().positive().safe(), digest: commerceHash });
const sourceBase = { contractVersion: z.literal(websiteSalesCommerceSourceContract), eventId: commerceUuid, identity: commerceIdentitySchema, workflowId: commerceUuid,
  source: commerceSourceBindingSchema, occurredAt: commerceTime, retrievedAt: commerceTime, verificationReceiptReference: commerceText.max(500),
  confidence: z.enum(['OPERATOR_RECORDED', 'PROVIDER_VERIFIED']), supersedesEventId: commerceUuid.nullable() };
const allocation = z.strictObject({ invoiceSourceEventId: commerceUuid, installmentId: commerceUuid, amountMinor: commerceMinor });
export const websiteSalesCommerceSourceEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...sourceBase, kind: z.literal('PROVIDER_DELIVERY'), payload: z.strictObject({ outboxId: commerceUuid, documentKind: z.enum(['OFFER', 'CONTRACT', 'INVOICE_REQUEST']), documentRef: commerceReferenceSchema,
    documentSha256: commerceHash, recipientDigest: commerceHash, providerMessageId: commerceExternalId, status: z.enum(['ACCEPTED', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED']) }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('SIGNATURE'), payload: z.strictObject({ contractRef: commerceReferenceSchema, documentSha256: commerceHash, envelopeId: commerceExternalId,
    status: z.enum(['PENDING', 'SIGNED', 'DECLINED', 'EXPIRED', 'VOIDED', 'SOURCE_UNAVAILABLE']), assurance: z.enum(['EMAIL_ACCESS', 'PROVIDER_ATTESTED', 'ADVANCED', 'QUALIFIED']), signatoryReference: commerceText.max(200), signedAt: commerceTime.nullable(), providerArchivedAt: commerceTime.nullable().optional(),
    providerSignedDocumentDigests: z.array(commerceHash).min(1).max(20).optional(), providerAuditProofDigests: z.array(commerceHash).min(1).max(20).optional(),
    auditProofReferences: z.array(commerceSourceReferenceSchema).min(1).max(20).optional() }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('DELIVERY_ACCEPTANCE'), payload: commerceDeliveryAcceptanceSchema }),
  z.strictObject({ ...sourceBase, kind: z.literal('INVOICE'), payload: z.strictObject({ invoiceRequestId: commerceUuid, contractRef: commerceReferenceSchema, customerReference: commerceExternalId, financial: commerceFinancialSnapshotSchema,
    installments: z.array(commerceInstallmentSchema).min(1).max(36), status: z.enum(['ISSUED', 'VOIDED']), invoiceNumber: commerceText.max(100) }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('PAYMENT'), payload: z.strictObject({ currency: commerceCurrency, amountMinor: commerceMinor, status: z.enum(['PENDING', 'SETTLED', 'FAILED']),
    kind: z.enum(['PAYMENT', 'DEPOSIT', 'ADVANCE']), allocations: z.array(allocation).max(100) }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('REFUND'), payload: z.strictObject({ paymentSourceEventId: commerceUuid, currency: commerceCurrency, amountMinor: commerceMinor,
    status: z.enum(['PENDING', 'SETTLED', 'FAILED']), allocations: z.array(allocation).max(100) }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('CREDIT_NOTE'), payload: z.strictObject({ invoiceSourceEventId: commerceUuid, currency: commerceCurrency, amountMinor: commerceMinor, status: z.enum(['ISSUED', 'VOIDED']) }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('REVERSAL'), payload: z.strictObject({ reversesEventId: commerceUuid, reversedEventDigest: commerceHash, reason: commerceText }) }),
  z.strictObject({ ...sourceBase, kind: z.literal('SUBSCRIPTION'), payload: commerceSubscriptionTermsSchema }),
]);
export type WebsiteSalesCommerceSourceEvent = z.infer<typeof websiteSalesCommerceSourceEventSchema>;
export const websiteSalesCommercePayloadSchemas = {
  register_template: commerceTemplateSchema, configure_policy: commercePolicySchema,
  prepare_contract: z.strictObject({ offerRef: commerceReferenceSchema, templateRef: commerceReferenceSchema, policyRef: commerceReferenceSchema }),
  request_contract_approval: z.strictObject({ documentRef: commerceReferenceSchema }),
  approve_contract_step: z.strictObject({ approvalId: commerceUuid, challengeId: commerceUuid, stepNumber: z.union([z.literal(1), z.literal(2)]), documentRef: commerceReferenceSchema }),
  revoke_contract_approval: z.strictObject({ approvalId: commerceUuid, documentRef: commerceReferenceSchema, reason: commerceText }),
  queue_offer_delivery: z.strictObject({ offerRef: commerceReferenceSchema, approvalReference: commerceUuid }),
  queue_contract_delivery: z.strictObject({ documentRef: commerceReferenceSchema, approvalReference: commerceUuid }),
  request_signature: z.strictObject({ documentRef: commerceReferenceSchema, approvalReference: commerceUuid }),
  record_delivery_acceptance: commerceDeliveryAcceptanceSchema,
  prepare_invoice_request: z.strictObject({ contractRef: commerceReferenceSchema, deliveryAcceptanceRef: commerceReferenceSchema.nullable(), policyRef: commerceReferenceSchema,
    stage: z.enum(['DEPOSIT', 'MILESTONE', 'BALANCE', 'RECURRING']), installmentIds: z.array(commerceUuid).min(1).max(36) }),
  record_subscription_terms: commerceSubscriptionTermsSchema.omit({ status: true, canonicalSourceEventId: true }),
  request_cancellation: z.strictObject({ subscriptionRef: commerceReferenceSchema, effectiveAt: commerceTime, sourceReference: commerceSourceReferenceSchema }),
  propose_renewal: z.strictObject({ subscriptionRef: commerceReferenceSchema }),
} as const;
export type WebsiteSalesCommerceOperation = keyof typeof websiteSalesCommercePayloadSchemas;
export const websiteSalesCommerceMachineOperations = ['prepare_contract', 'queue_offer_delivery', 'queue_contract_delivery', 'request_signature', 'prepare_invoice_request', 'propose_renewal'] as const;
export const websiteSalesCommerceOwnerOperations = ['register_template', 'configure_policy', 'request_contract_approval', 'approve_contract_step', 'revoke_contract_approval', 'record_delivery_acceptance', 'record_subscription_terms', 'request_cancellation'] as const;
const operations = Object.keys(websiteSalesCommercePayloadSchemas) as [WebsiteSalesCommerceOperation, ...WebsiteSalesCommerceOperation[]];
export const websiteSalesCommerceCommandSchema = z.strictObject({ contractVersion: z.literal(websiteSalesCommerceContract), operation: z.enum(operations),
  projectId: commerceUuid, companyId: commerceUuid, locationId: commerceUuid.nullable(), workflowId: commerceUuid,
  expectedVersion: z.number().int().nonnegative().safe(), expectedWorkflowVersion: z.number().int().positive().safe(), idempotencyKey: z.uuidv4(), correlationId: z.uuidv4(),
  payload: z.record(z.string(), z.unknown()) }).superRefine((value, ctx) => { const parsed = websiteSalesCommercePayloadSchemas[value.operation].safeParse(value.payload);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message }); });
export type WebsiteSalesCommerceCommand = z.infer<typeof websiteSalesCommerceCommandSchema>;
export type CommerceIdentity = z.infer<typeof commerceIdentitySchema>;
export type CommerceReference = z.infer<typeof commerceReferenceSchema>;
export type CommerceRecord<T> = { id: string; identity: CommerceIdentity; workflowId: string; version: number; workflowVersion: number; digest: string; createdBy: string; createdAt: string; validUntil: string | null; revokedAt: string | null; payload: T };
export const commerceOutboxSchema = z.strictObject({ id: commerceUuid, identity: commerceIdentitySchema, workflowId: commerceUuid, version: z.number().int().positive().safe(),
  kind: z.enum(['OFFER_SEND', 'CONTRACT_SEND', 'SIGNATURE_REQUEST', 'ACCOUNTING_INVOICE_REQUEST', 'REFUND_REQUEST', 'SUBSCRIPTION_CHANGE']), documentRef: commerceReferenceSchema,
  payloadDigest: commerceHash, status: z.enum(['READY', 'CLAIMED', 'ACCEPTED', 'UNKNOWN', 'REJECTED', 'CANCELLED']), providerReference: commerceExternalId.nullable(), updatedAt: commerceTime });
export const commerceSourceAssessmentSchema = z.strictObject({ status: z.enum(['READY', 'BLOCKED', 'NEEDS_RECONCILIATION']), activeEventIds: z.array(commerceUuid).max(500),
  invalidatedEventIds: z.array(commerceUuid).max(500), reasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).max(100), complete: z.boolean() })
  .refine(value => value.status === 'READY' ? value.complete && value.reasons.length === 0 : !value.complete && value.reasons.length > 0, 'COMMERCE_SOURCE_ASSESSMENT_INVALID');
export type CommerceSourceAssessment = z.infer<typeof commerceSourceAssessmentSchema>;
export const commerceInvoicePositionSchema = z.strictObject({ invoiceSourceEventId: commerceUuid, currency: commerceCurrency, grossMinor: commerceMinor, creditMinor: commerceMinor, paidMinor: commerceMinor,
  refundedMinor: commerceMinor, outstandingMinor: commerceMinor, creditAllocationKnown: z.boolean(), installments: z.array(z.strictObject({ installmentId: commerceUuid, amountMinor: commerceMinor,
    paidMinor: commerceMinor, refundedMinor: commerceMinor, outstandingMinor: commerceMinor.nullable() })).min(1).max(36) })
  .refine(value => value.creditAllocationKnown === (value.creditMinor === 0) && value.installments.every(row => value.creditAllocationKnown ? row.outstandingMinor !== null : row.outstandingMinor === null), 'COMMERCE_CREDIT_ALLOCATION_UNKNOWN');
export const commerceFinancialProjectionSchema = z.strictObject({ complete: z.boolean(), accountingLedger: z.literal(false), forecast: z.null(), invoices: z.array(commerceInvoicePositionSchema).max(1000),
  currencies: z.array(z.strictObject({ currency: commerceCurrency, invoicedMinor: commerceMinor, creditedMinor: commerceMinor, settledPaymentMinor: commerceMinor, settledRefundMinor: commerceMinor,
    unallocatedAdvanceMinor: commerceMinor, outstandingMinor: commerceMinor })).max(3), excludedOperatorEventIds: z.array(commerceUuid).max(1000), activeSourceEventIds: z.array(commerceUuid).max(1000) });
export type CommerceInvoicePosition = z.infer<typeof commerceInvoicePositionSchema>;
export type CommerceFinancialProjection = z.infer<typeof commerceFinancialProjectionSchema>;
export const commerceFinancialAssessmentSchema = z.strictObject({ status: z.enum(['READY', 'BLOCKED', 'NEEDS_RECONCILIATION']), reasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).max(100),
  value: commerceFinancialProjectionSchema.nullable(), externalEffectAllowed: z.literal(false), requiresServerAuthorization: z.literal(true) })
  .refine(value => value.status === 'READY' ? value.reasons.length === 0 && value.value?.complete === true : value.reasons.length > 0 && (value.value === null || !value.value.complete), 'COMMERCE_FINANCIAL_ASSESSMENT_INVALID');
export type CommerceFinancialAssessment = z.infer<typeof commerceFinancialAssessmentSchema>;
export const websiteSalesCommerceReadSchema = z.strictObject({ contractVersion: z.literal(websiteSalesCommerceContract), source: z.literal('database'), identity: commerceIdentitySchema,
  workflowId: commerceUuid, version: z.number().int().nonnegative().safe(), workflowVersion: z.number().int().positive().safe(), canWrite: z.boolean(), canApproveFacts: z.boolean(), canApproveContract: z.boolean(), canContact: z.literal(false),
  actionEligibility: z.array(z.strictObject({ operation: z.enum(operations), eligible: z.boolean(), blockers: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).max(30) })).max(30),
  eligibleDeliveryTasks: z.array(z.strictObject({ taskRef: commerceReferenceSchema, identity: commerceIdentitySchema, workflowId: commerceUuid, title: commerceText.max(200), status: z.literal('DONE') })).max(100),
  sourceConnections: z.array(z.strictObject({ reference: commerceText.max(200), provider: commerceText.max(100), type: z.enum(['DELIVERY', 'SIGNATURE', 'ACCOUNTING', 'PAYMENT', 'SUBSCRIPTION', 'SERVICE']),
    status: z.enum(['DISABLED', 'READY', 'EXPIRED', 'REVOKED', 'MISCONFIGURED']), expiresAt: commerceTime.nullable() })).max(20),
  templates: z.array(commerceRecordSchema(commerceTemplateSchema)).max(25), policy: commerceRecordSchema(commercePolicySchema).nullable(), policies: z.array(commerceRecordSchema(commercePolicySchema)).max(25).optional(),
  offerChoices: z.array(commerceOfferChoiceSchema).max(25),
  offers: z.array(commerceRecordSchema(commerceOfferSchema)).max(25), contracts: z.array(commerceRecordSchema(commerceContractDraftSchema)).max(25), approvals: z.array(commerceApprovalSchema).max(50),
  deliveryAcceptances: z.array(commerceRecordSchema(commerceDeliveryAcceptanceSchema)).max(25), invoiceRequests: z.array(commerceRecordSchema(commerceInvoiceRequestSchema)).max(25),
  invoices: z.array(websiteSalesCommerceSourceEventSchema).max(100), payments: z.array(websiteSalesCommerceSourceEventSchema).max(200),
  subscriptions: z.array(commerceRecordSchema(commerceSubscriptionTermsSchema)).max(25), outbox: z.array(commerceOutboxSchema).max(100), sourceEvents: z.array(websiteSalesCommerceSourceEventSchema).max(500), sourceAssessment: commerceSourceAssessmentSchema,
  financialAssessment: commerceFinancialAssessmentSchema.optional(),
  blockers: z.array(z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), reference: commerceText.max(500).nullable() })).max(100) });
export type WebsiteSalesCommerceRead = z.infer<typeof websiteSalesCommerceReadSchema>;
export const websiteSalesCommerceEffectSchema = z.strictObject({ identity: commerceIdentitySchema, workflowId: commerceUuid, version: z.number().int().positive().safe(), workflowVersion: z.number().int().positive().safe(),
  recordId: commerceUuid.nullable(), recordDigest: commerceHash.nullable(), outboxId: commerceUuid.nullable(), canContact: z.literal(false) });
export const websiteSalesCommerceReceiptSchema = z.strictObject({ contractVersion: z.literal(websiteSalesCommerceContract), persisted: z.literal(true), commandId: commerceUuid,
  auditReference: commerceUuid, correlationId: z.uuidv4(), replayed: z.boolean(), data: websiteSalesCommerceEffectSchema });
export const websiteSalesCommerceReconcileSchema = z.discriminatedUnion('status', [z.strictObject({ contractVersion: z.literal('website-sales-commerce-reconcile-v1'), status: z.literal('NOT_FOUND'), correlationId: z.uuidv4() }),
  z.strictObject({ contractVersion: z.literal('website-sales-commerce-reconcile-v1'), status: z.literal('COMMITTED'), correlationId: z.uuidv4(), receipt: websiteSalesCommerceReceiptSchema, currentData: websiteSalesCommerceReadSchema })]);
