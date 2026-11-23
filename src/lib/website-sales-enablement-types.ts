import { z } from 'zod';

/** Browser-safe wire contracts. Canonical records/permissions are hydrated and authorized by CRM, never by these DTOs. */
export const websiteSalesEnablementContract = 'website-sales-enablement-v1' as const;
export const enablementUuid = z.uuid().transform(value => value.toLowerCase());
export const enablementHash = z.hash('sha256');
export const enablementTime = z.iso.datetime({ offset: true });
export const enablementText = z.string().trim().min(1).max(1_000).refine(value => !/\u0000|-----BEGIN.{0,40}PRIVATE KEY|\b(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|(?:postgres(?:ql)?|mongodb):\/\//i.test(value), 'ENABLEMENT_PRIVATE_OR_UNSAFE_CONTENT');
const short = enablementText.max(200), list = z.array(enablementText).max(30);
export const enablementScopeSchema = z.strictObject({ workspaceId: enablementUuid, projectId: enablementUuid });
export const enablementIdentitySchema = enablementScopeSchema.extend({ companyId: enablementUuid, locationId: enablementUuid });
export const enablementSourceReferenceSchema = z.strictObject({ reference: enablementText.max(500), digest: enablementHash,
  basis: z.enum(['OPERATOR_ATTESTATION', 'CUSTOMER_STATEMENT_RECORDED', 'CUSTOMER_AGREEMENT_RECORDED', 'APPROVED_KNOWLEDGE', 'CANONICAL_CRM_RECORD']),
  observedAt: enablementTime, validUntil: enablementTime });
const sources = z.array(enablementSourceReferenceSchema).min(1).max(30);
export const customerBudgetSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('UNKNOWN'), amountMinor: z.null(), currency: z.literal('EUR') }),
  z.strictObject({ status: z.literal('KNOWN'), amountMinor: z.number().int().nonnegative().safe(), currency: z.literal('EUR') }),
]);
export const customerBriefSchema = z.strictObject({ goals: list, audience: list, customerBudget: customerBudgetSchema,
  timeframe: z.strictObject({ status: z.enum(['KNOWN', 'UNKNOWN']), targetDate: enablementTime.nullable() }).refine(value => (value.status === 'KNOWN') === (value.targetDate !== null), 'TIMEFRAME_KNOWLEDGE_MISMATCH'),
  services: list, sourceReferences: sources, openQuestions: list, validUntil: enablementTime });
export const closePlanSchema = z.strictObject({ contacts: z.array(z.strictObject({ contactId: enablementUuid,
  contactVersion: z.number().int().positive().safe().optional(), sourceDigest: enablementHash.optional(),
  roles: z.array(z.enum(['DECISION_MAKER', 'SIGNATORY', 'BUDGET_OWNER', 'TECHNICAL_REVIEWER', 'CONTENT_OWNER', 'CONTACT'])).min(1).max(6),
  verificationBasis: z.enum(['OPERATOR_RECORDED', 'CUSTOMER_STATEMENT_RECORDED']), sourceReferences: sources })).max(30),
  milestones: z.array(z.strictObject({ taskId: enablementUuid, taskVersion: z.number().int().positive().safe(),
    kind: z.enum(['INTERNAL_TARGET', 'CUSTOMER_AGREEMENT_RECORDED']), sourceReferences: sources })).max(30),
  nextStepTaskId: enablementUuid.nullable(), sourceReferences: sources, validUntil: enablementTime });
export const industryCodeSchema = z.enum(['GENERAL', 'HOSPITALITY', 'PROFESSIONAL_SERVICES', 'LOCAL_SERVICE', 'RETAIL', 'HEALTH_WELLNESS']);
export const referenceCaseSchema = z.strictObject({ title: short, industryCode: industryCodeSchema,
  summary: enablementText, claims: z.array(z.strictObject({ text: enablementText, sourceReferences: sources })).min(1).max(12),
  rightsReference: enablementText.max(500), disclosure: z.enum(['NOVALURE_INTERNAL', 'APPROVED_CUSTOMER_PRESENTATION']),
  sourceReferences: sources, validUntil: enablementTime });
export const referenceReviewSchema = z.strictObject({ referenceId: enablementUuid, referenceVersion: z.number().int().positive().safe(),
  referenceDigest: enablementHash, approvalId: enablementUuid, approvedBy: enablementUuid, approvedAt: enablementTime,
  validUntil: enablementTime, revokedAt: enablementTime.nullable() });
const hex = z.string().regex(/^#[A-Fa-f0-9]{6}$/).transform(value => value.toLowerCase());
export const demoProfileSchema = z.strictObject({ industryCode: industryCodeSchema,
  brandPalette: z.strictObject({ primary: hex, background: hex, text: hex, accent: hex }),
  referenceCaseIds: z.array(enablementUuid).max(5), assetIds: z.array(enablementUuid).max(2), sourceReferences: sources, validUntil: enablementTime });
export const demoProfileBindingSchema = z.strictObject({ profileId: enablementUuid, version: z.number().int().positive().safe(), digest: enablementHash });
export const closureReasonSchema = z.strictObject({ reasonCode: z.enum(['PRICE', 'TIMING', 'SCOPE', 'COMPETITOR', 'NO_BUDGET', 'NO_NEED', 'NO_DECISION', 'CUSTOMER_CANCELLED', 'UNKNOWN']),
  explanation: enablementText, sourceReferences: sources, industryCode: industryCodeSchema.nullable(), offerVersion: z.number().int().positive().safe().nullable(), validUntil: enablementTime });
export const carePlanKeySchema = z.enum(['MANAGED', 'PERFORMANCE', 'CONVERSION']);
export const careRenewalBasisSchema = z.strictObject({ canonicalAcceptedCareOfferId: enablementUuid,
  serviceStartAt: enablementTime, reviewAt: enablementTime, sourceReferences: sources });
export const careBasisSchema = z.strictObject({ need: enablementText, sourceReferences: sources,
  canonicalDeliveryTaskId: enablementUuid, planKeys: z.array(carePlanKeySchema).min(1).max(3), validUntil: enablementTime,
  renewal: careRenewalBasisSchema.optional() });
export const uploadEnablementAssetSchema = z.strictObject({ role: z.enum(['LOGO', 'HERO']), title: short, alt: enablementText,
  rightsReference: enablementText.max(500), validUntil: enablementTime, originalSha256: enablementHash,
  originalSizeBytes: z.number().int().min(1).max(4_194_304), originalMime: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
export const enablementAssetMetadataSchema = z.strictObject({ assetId: enablementUuid, identity: enablementIdentitySchema,
  version: z.number().int().positive().safe(), digest: enablementHash, role: z.enum(['LOGO', 'HERO']), title: short, alt: enablementText,
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']), sha256: enablementHash, sizeBytes: z.number().int().min(1).max(262_144),
  width: z.number().int().min(1).max(8_192), height: z.number().int().min(1).max(8_192), rightsReference: enablementText.max(500),
  rightsBasis: z.literal('OPERATOR_ATTESTED'), approvedBy: enablementUuid, approvedAt: enablementTime, validUntil: enablementTime,
  revokedAt: enablementTime.nullable() });
export const hygieneAnnotationSchema = z.strictObject({ candidateDigest: enablementHash,
  disposition: z.enum(['DISTINCT_RECORDS', 'POSSIBLE_DUPLICATE_REVIEW_REQUIRED', 'NEEDS_MORE_EVIDENCE']), rationale: enablementText, sourceReferences: sources });
export const enablementPayloadSchemas = {
  record_brief: customerBriefSchema,
  record_close_plan: closePlanSchema,
  register_reference: referenceCaseSchema,
  approve_reference: z.strictObject({ referenceId: enablementUuid, referenceVersion: z.number().int().positive().safe(), referenceDigest: enablementHash, validUntil: enablementTime }),
  revoke_reference: z.strictObject({ referenceId: enablementUuid, reason: enablementText }),
  record_demo_profile: demoProfileSchema,
  record_closure_reason: closureReasonSchema,
  record_care_basis: careBasisSchema,
  propose_next_step: z.strictObject({ closePlanId: enablementUuid, closePlanDigest: enablementHash }),
  propose_care: z.strictObject({ planKey: carePlanKeySchema, basisId: enablementUuid, basisDigest: enablementHash }),
  prepare_care_offer: z.strictObject({ careProposalId: enablementUuid, careProposalDigest: enablementHash, expectedDeliveryTaskVersion: z.number().int().positive().safe() }),
  scan_hygiene: z.strictObject({ organizationIds: z.array(enablementUuid).max(200), contactIds: z.array(enablementUuid).max(500) }),
  annotate_hygiene: hygieneAnnotationSchema,
  upload_asset: uploadEnablementAssetSchema,
  revoke_asset: z.strictObject({ assetId: enablementUuid, reason: enablementText }),
} as const;
export type WebsiteSalesEnablementOperation = keyof typeof enablementPayloadSchemas;
export const enablementResourceGrantsSchema = z.array(z.strictObject({ companyId: enablementUuid, locationId: enablementUuid, grantId: enablementUuid })).max(49)
  .refine(rows => new Set(rows.map(row => `${row.companyId}:${row.locationId}`)).size === rows.length && new Set(rows.map(row => row.grantId)).size === rows.length, 'DUPLICATE_RESOURCE_GRANT');
export function parseWebsiteSalesEnablementPayload<O extends WebsiteSalesEnablementOperation>(operation: O, raw: unknown): z.infer<(typeof enablementPayloadSchemas)[O]> {
  const parsed = enablementPayloadSchemas[operation].extend({ resourceGrants: enablementResourceGrantsSchema.optional() }).parse(raw);
  const facts = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'resourceGrants'));
  return enablementPayloadSchemas[operation].parse(facts) as z.infer<(typeof enablementPayloadSchemas)[O]>;
}
export const websiteSalesEnablementOperations = Object.keys(enablementPayloadSchemas) as [WebsiteSalesEnablementOperation, ...WebsiteSalesEnablementOperation[]];
export const websiteSalesEnablementOwnerOperations = Object.freeze(websiteSalesEnablementOperations.filter(operation => !['propose_next_step', 'propose_care', 'prepare_care_offer', 'scan_hygiene'].includes(operation)));
export const websiteSalesEnablementCommandSchema = z.strictObject({ contractVersion: z.literal(websiteSalesEnablementContract),
  operation: z.enum(websiteSalesEnablementOperations), projectId: enablementUuid, companyId: enablementUuid, locationId: enablementUuid,
  expectedVersion: z.number().int().nonnegative().safe(), expectedWorkflowVersion: z.number().int().positive().safe(),
  idempotencyKey: z.uuidv4(), correlationId: z.uuidv4(), payload: z.record(z.string(), z.unknown()) }).superRefine((value, ctx) => {
    const parsed = enablementPayloadSchemas[value.operation].extend({ resourceGrants: enablementResourceGrantsSchema.optional() }).safeParse(value.payload);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message });
  });
export type WebsiteSalesEnablementCommand = z.infer<typeof websiteSalesEnablementCommandSchema>;
export function canonicalEnablementRecordSchema<T extends z.ZodType>(payload: T) {
  return z.strictObject({ id: enablementUuid, identity: enablementIdentitySchema, version: z.number().int().positive().safe(),
    workflowVersion: z.number().int().positive().safe(), digest: enablementHash, recordedBy: enablementUuid, createdAt: enablementTime,
    validUntil: enablementTime, revokedAt: enablementTime.nullable(), payload });
}
export const canonicalEnablementTaskSchema = z.strictObject({ taskId: enablementUuid, identity: enablementIdentitySchema,
  version: z.number().int().positive().safe(), title: short, status: z.enum(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']),
  dueAt: enablementTime.nullable(), observedAt: enablementTime, blockedReason: enablementText.nullable() });
export const canonicalEnablementContactSchema = z.strictObject({ contactId: enablementUuid, identity: enablementIdentitySchema,
  version: z.number().int().positive().safe(), sourceDigest: enablementHash, displayName: short, active: z.boolean() });
export const canonicalEnablementWorkflowSchema = z.strictObject({ workflowId: enablementUuid, identity: enablementIdentitySchema,
  version: z.number().int().positive().safe(), status: z.enum(['OBSERVED', 'QUALIFIED', 'OFFER_DRAFT', 'STOPPED', 'WON', 'LOST']),
  blockedReason: enablementText.nullable(), evidenceDigest: enablementHash, observedAt: enablementTime });
export type EnablementIdentity = z.infer<typeof enablementIdentitySchema>;
export type EnablementSourceReference = z.infer<typeof enablementSourceReferenceSchema>;
export type WebsiteCustomerBrief = z.infer<typeof customerBriefSchema>;
export type WebsiteClosePlan = z.infer<typeof closePlanSchema>;
export type WebsiteReferenceCase = z.infer<typeof referenceCaseSchema>;
export type WebsiteReferenceReview = z.infer<typeof referenceReviewSchema>;
export type WebsiteDemoProfile = z.infer<typeof demoProfileSchema>;
export type WebsiteClosureReason = z.infer<typeof closureReasonSchema>;
export type WebsiteCareBasis = z.infer<typeof careBasisSchema>;
export type WebsiteCarePlanKey = z.infer<typeof carePlanKeySchema>;
export type WebsiteEnablementAssetMetadata = z.infer<typeof enablementAssetMetadataSchema>;
export type CanonicalEnablementTask = z.infer<typeof canonicalEnablementTaskSchema>;
export type CanonicalEnablementContact = z.infer<typeof canonicalEnablementContactSchema>;
export type CanonicalEnablementWorkflow = z.infer<typeof canonicalEnablementWorkflowSchema>;
export type CanonicalEnablementRecord<T> = { id: string; identity: EnablementIdentity; version: number; workflowVersion: number;
  digest: string; recordedBy: string; createdAt: string; validUntil: string; revokedAt: string | null; payload: T };
export type EnablementEvaluation<T> = { status: 'READY' | 'NEEDS_CLARIFICATION' | 'BLOCKED'; reasons: string[]; value: T | null;
  digest: string; externalEffectAllowed: false; requiresServerAuthorization: true };
export const websiteSalesCareProposalSchema = z.strictObject({ planKey: carePlanKeySchema, basisId: enablementUuid, basisDigest: enablementHash,
  deliveryTaskId: enablementUuid, deliveryTaskVersion: z.number().int().positive().safe(), catalogDigest: enablementHash, currency: z.literal('EUR'),
  schedule: z.array(z.strictObject({ fromMonth: z.number().int().positive().safe(), throughMonth: z.number().int().positive().safe().nullable(),
    netMonthlyMinor: z.number().int().nonnegative().safe() })).min(1).max(3),
  renewal: z.strictObject({ canonicalAcceptedCareOfferId: enablementUuid, serviceStartAt: enablementTime, reviewAt: enablementTime,
    serviceMonth: z.number().int().positive().safe(), sourceConfidence: z.literal('OPERATOR_RECORDED') }).nullable(),
  finalOfferApprovalRequired: z.literal(true), autoRenewalAllowed: z.literal(false), invoiceAllowed: z.literal(false), contractExecutionAllowed: z.literal(false) });
export type WebsiteCareProposal = z.infer<typeof websiteSalesCareProposalSchema>;
export interface WebsiteDailyPriority { taskId: string; taskVersion: number; identity: EnablementIdentity; title: string; dueAt: string | null;
  status: CanonicalEnablementTask['status']; priority: 'OVERDUE' | 'DUE_TODAY' | 'BLOCKED' | 'UPCOMING' | 'UNSCHEDULED'; reasons: string[] }
export interface WebsiteHygieneCandidate { kind: 'ORGANIZATION' | 'CONTACT'; recordIds: string[]; recordVersions: number[];
  reasons: string[]; candidateDigest: string; autoMergeAllowed: false; realRecordMutationAllowed: false }
export interface WebsiteSalesEnablementRead {
  contractVersion: typeof websiteSalesEnablementContract; source: 'database'; identity: EnablementIdentity; aggregateVersion: number; workflowVersion: number;
  canWrite: boolean; canApproveFacts: boolean; canContact: false; workflow: CanonicalEnablementWorkflow | null;
  contacts: CanonicalEnablementContact[]; tasks: CanonicalEnablementTask[];
  brief: CanonicalEnablementRecord<WebsiteCustomerBrief> | null; closePlan: CanonicalEnablementRecord<WebsiteClosePlan> | null;
  references: CanonicalEnablementRecord<WebsiteReferenceCase>[]; referenceReviews: WebsiteReferenceReview[];
  demoProfiles: CanonicalEnablementRecord<WebsiteDemoProfile>[]; assets: WebsiteEnablementAssetMetadata[];
  closureReasons: CanonicalEnablementRecord<WebsiteClosureReason>[]; careBases: CanonicalEnablementRecord<WebsiteCareBasis>[];
  careCandidates: CanonicalEnablementRecord<WebsiteCareProposal>[]; dailyPriorities: WebsiteDailyPriority[]; hygieneCandidates: WebsiteHygieneCandidate[];
  careOffers: { careProposalId: string; careProposalDigest: string; dealId: string; offerId: string; offerVersion: number; taskId: string | null; status: 'DRAFT' }[];
}
export interface WebsiteSalesEnablementProjectRead { contractVersion: typeof websiteSalesEnablementContract; source: 'database';
  workspaceId: string; projectId: string; projection: 'PROJECT'; dailyPriorities: WebsiteDailyPriority[];
  page: { cursor: string | null; hasMore: boolean }; canWrite: boolean; canContact: false }
export interface WebsiteSalesEnablementEffect { identity: EnablementIdentity; aggregateVersion: number; workflowVersion: number;
  recordId: string; recordDigest: string; taskId?: string; dealId?: string; offerId?: string; offerVersion?: number; assetId?: string }

/** Derived internal snapshot of the existing controlled Markdown catalog; tests bind every price back to that source. No customer price authority. */
export const CANONICAL_WEBSITE_SALES_CATALOG = Object.freeze({ sourcePath: 'docs/business/website-sales-pricing-catalog.md',
  sourceRevision: '71d20a5731cdf870f59d8f9c220f15550f4e20cd', sourceDigest: '5c90752cac9852fcbf97f4bff784c59eeb42d6a1905c5eba50b680a0cc2081e6',
  currency: 'EUR' as const, packageNetMinor: Object.freeze({ STARTER: 79_000, BUSINESS: 199_000, PREMIUM: 349_000 }),
  care: Object.freeze({ MANAGED: Object.freeze([{ fromMonth: 1, throughMonth: 12, netMonthlyMinor: 3_900 }, { fromMonth: 13, throughMonth: null, netMonthlyMinor: 9_900 }]),
    PERFORMANCE: Object.freeze([{ fromMonth: 1, throughMonth: null, netMonthlyMinor: 14_900 }]),
    CONVERSION: Object.freeze([{ fromMonth: 1, throughMonth: null, netMonthlyMinor: 22_900 }]) }) });
