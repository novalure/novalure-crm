import { z } from 'zod';

/** Browser-safe data only. CRM resolves authority, current sources and permissions. */
export const websiteSalesAdvisoryContract = 'website-sales-advisory-v1' as const;
export const advisoryUuid = z.uuid().transform(value => value.toLowerCase());
export const advisoryHash = z.hash('sha256');
export const advisoryTime = z.iso.datetime({ offset: true });
export const advisoryText = z.string().trim().min(1).max(2000).refine(s => !/\u0000|-----BEGIN.{0,40}PRIVATE KEY|\b(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\//i.test(s), 'ADVISORY_UNSAFE_TEXT');
const short = advisoryText.max(200), minor = z.number().int().nonnegative().safe(), integer = z.number().int().nonnegative().safe();
export const advisoryIdentitySchema = z.strictObject({ workspaceId: advisoryUuid, projectId: advisoryUuid, companyId: advisoryUuid, locationId: advisoryUuid });
export const advisoryReferenceSchema = z.strictObject({ id: advisoryUuid, version: z.number().int().positive().safe(), digest: advisoryHash });
export const advisorySourceSchema = z.strictObject({ id: advisoryUuid, reference: advisoryText.max(500), digest: advisoryHash,
  basis: z.enum(['CANONICAL_CRM', 'MEASUREMENT', 'CUSTOMER_STATEMENT_RECORDED', 'OPERATOR_RECORDED', 'APPROVED_KNOWLEDGE', 'PUBLIC_OBSERVATION', 'TRANSCRIPT_SEGMENT']), observedAt: advisoryTime, validUntil: advisoryTime });
const sources = z.array(advisorySourceSchema).min(1).max(20), refs = z.array(advisoryReferenceSchema).max(20);
export const advisoryCohortMemberSchema = z.strictObject({ identity: advisoryIdentitySchema, workflowId: advisoryUuid, workflowVersion: z.number().int().positive().safe(), assignedAt: advisoryTime, sourceDigest: advisoryHash });
export const advisoryObservationSchema = z.strictObject({ identity: advisoryIdentitySchema, workflowId: advisoryUuid, assignedAt: advisoryTime, horizonDays: z.number().int().min(1).max(365),
  segmentKey: short, treatmentDigest: advisoryHash, outcome: z.enum(['WON', 'NOT_WON', 'PENDING', 'UNKNOWN']), outcomeAt: advisoryTime.nullable(), availableAt: advisoryTime,
  coverage: z.enum(['COMPLETE', 'INCOMPLETE']), cohortSourceDigest: advisoryHash, sourceDigest: advisoryHash });
export const advisoryBenefitComponentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: advisoryUuid, effectKey: short, kind: z.literal('TIME_SAVING'), minutesPerMonth: integer.max(1_000_000), hourlyCostMinor: minor,
    treatment: z.enum(['CAPACITY_ONLY', 'ASSUMED_CASH_REDUCTION']), sourceReferences: sources }),
  z.strictObject({ id: advisoryUuid, effectKey: short, kind: z.literal('CONTRIBUTION'), additionalOrdersDecimal: z.string().regex(/^\d{1,7}(?:\.\d{1,3})?$/), contributionPerOrderMinor: minor, sourceReferences: sources }),
]);
export const advisoryValueBasisSchema = z.strictObject({ title: short, offerRef: advisoryReferenceSchema, currency: z.literal('EUR'), amountBasis: z.literal('NET'),
  horizonMonths: z.number().int().min(1).max(36), oneTimeCostMinor: minor, monthlyCostMinor: minor,
  scenarios: z.array(z.strictObject({ name: z.enum(['LOW', 'BASE', 'HIGH']), monthlyBenefitMinor: minor.optional(), components: z.array(advisoryBenefitComponentSchema).min(1).max(12).optional(), startsAtMonth: z.number().int().min(1).max(36),
    assumption: advisoryText, sourceReferences: sources }).refine(v => (v.monthlyBenefitMinor !== undefined) !== (v.components !== undefined), 'ADVISORY_BENEFIT_BASIS_REQUIRED')).min(1).max(3), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryDiscoveryAnswerSchema = z.strictObject({ briefRef: advisoryReferenceSchema, questionId: short,
  kind: z.enum(['SITUATION', 'PROBLEM', 'IMPLICATION', 'NEED_PAYOFF']), answer: advisoryText, sourceReferences: sources, validUntil: advisoryTime });
export const advisoryTranscriptSegmentSchema = z.strictObject({ id: advisoryUuid, speaker: z.enum(['CUSTOMER', 'SELLER', 'OTHER']), startMs: integer.max(14_400_000), endMs: integer.max(14_400_000), text: advisoryText.max(1000) }).refine(v => v.endMs > v.startMs, 'ADVISORY_SEGMENT_TIME_INVALID');
export const advisoryTranscriptSchema = z.strictObject({ title: short, segments: z.array(advisoryTranscriptSegmentSchema).min(1).max(90),
  permissionReference: advisorySourceSchema, sourceReferences: sources, validUntil: advisoryTime });
export const advisoryAssertionSchema = z.strictObject({ id: advisoryUuid, text: advisoryText, segmentIds: z.array(advisoryUuid).min(1).max(10), exactQuotes: z.array(advisoryText.max(1000)).min(1).max(10), kind: z.enum(['NEED', 'CONSTRAINT', 'QUESTION', 'POSSIBLE_COMMITMENT']) });
export const advisoryTranscriptReviewSchema = z.strictObject({ transcriptRef: advisoryReferenceSchema, analysisRef: advisoryReferenceSchema,
  decisions: z.array(z.strictObject({ assertionId: advisoryUuid, decision: z.enum(['ACCEPTED_AS_RECORDED', 'REJECTED']), reason: advisoryText })).min(1).max(30) });
export const advisoryKnowledgeSchema = z.strictObject({ title: short, kind: z.enum(['PLAYBOOK', 'RUBRIC', 'ROLEPLAY']), content: advisoryText,
  disclosure: z.enum(['INTERNAL', 'CUSTOMER_APPROVAL_REQUIRED']), allowedUse: z.enum(['ORIGINAL_NOVALURE', 'PUBLIC_SUMMARY', 'LICENSED_INTERNAL']), fullCopyrightedContentStored: z.literal(false), rightsReference: advisorySourceSchema,
  criteria: z.array(z.strictObject({ id: short, label: short, evidenceTerms: z.array(short).min(1).max(10) })).max(12),
  scenarios: z.array(z.strictObject({ id: short, situation: advisoryText, customerOpening: advisoryText })).max(12), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryExperimentPlanSchema = z.strictObject({ title: short, hypothesis: advisoryText, metric: z.literal('WON_WITHIN_HORIZON'),
  horizonDays: z.number().int().min(1).max(365), registeredAt: advisoryTime, enrollmentEndsAt: advisoryTime,
  maximumCompanies: z.number().int().min(2).max(10000), minimumPerArm: z.number().int().min(1).max(5000), maximumUnknownBps: integer.max(10000),
  controlRef: advisoryReferenceSchema, variantRef: advisoryReferenceSchema, eligibilityDigest: advisoryHash, assignmentSaltDigest: advisoryHash,
  cohort: z.array(advisoryCohortMemberSchema).min(2).max(50), sourceReferences: sources, promotion: z.literal('REVIEW_REQUIRED') });
export const advisoryForecastPolicySchema = z.strictObject({ title: short, validationMode: z.enum(['PREREGISTERED_TIME_HOLDOUT', 'RETROSPECTIVE_TIME_HOLDOUT']).default('PREREGISTERED_TIME_HOLDOUT'), horizonDays: z.number().int().min(1).max(365), segmentKey: short,
  treatmentDigest: advisoryHash, trainEndsAt: advisoryTime, holdoutStartsAt: advisoryTime, holdoutEndsAt: advisoryTime,
  minimumTrain: z.number().int().min(10).max(10000), minimumHoldout: z.number().int().min(5).max(10000), minimumClassCount: z.number().int().min(1).max(1000),
  maximumIntervalWidthBps: integer.max(10000), maximumBrierBps: integer.max(10000), cohort: z.array(advisoryCohortMemberSchema).min(1).max(50), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryBuyerStepSchema = z.strictObject({ id: advisoryUuid, label: short, responsible: z.enum(['BUYER', 'NOVALURE']), dueAt: advisoryTime.nullable(),
  basis: z.enum(['INTERNAL_PROPOSAL', 'CUSTOMER_AGREEMENT_RECORDED']), sourceReferences: sources });
export const advisoryBuyerPacketInputSchema = z.strictObject({ title: short, briefRef: advisoryReferenceSchema, closePlanRef: advisoryReferenceSchema.nullable(), valueCaseRef: advisoryReferenceSchema.nullable(),
  demoRefs: refs, decisionCriteria: z.array(short).min(1).max(12), options: z.array(z.strictObject({ label: short, benefits: z.array(short).max(8), limits: z.array(short).max(8) })).min(1).max(4),
  steps: z.array(advisoryBuyerStepSchema).max(15), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryAdviceInputSchema = z.strictObject({ kind: z.enum(['WEBSITE', 'DEMO']), question: advisoryText, buyerQuestionId: advisoryUuid.optional(), factRefs: refs.min(1), artifactRefs: refs, knowledgeRefs: refs });
export const advisoryVideoInputSchema = z.strictObject({ demoRef: advisoryReferenceSchema, packetRef: advisoryReferenceSchema.nullable(), title: short,
  language: z.enum(['de', 'en']), maximumSeconds: z.number().int().min(20).max(180), goal: advisoryText, assetRefs: refs });
export const advisoryRoleplayInputSchema = z.strictObject({ knowledgeRef: advisoryReferenceSchema, scenarioId: short, previousRoleplayRef: advisoryReferenceSchema.optional(), sellerReply: advisoryText.optional() })
  .refine(v => (v.previousRoleplayRef !== undefined) === (v.sellerReply !== undefined), 'ADVISORY_ROLEPLAY_PREVIOUS_TURN_REQUIRED');
export const advisoryCanonicalParentSchema = z.strictObject({ reference: advisoryReferenceSchema, identity: advisoryIdentitySchema, workflowId: advisoryUuid,
  workflowVersion: z.number().int().positive().safe(), kind: z.enum(['BRIEF', 'CLOSE_PLAN', 'DEMO', 'ASSET', 'OFFER']), label: short, validUntil: advisoryTime.nullable(), revokedAt: advisoryTime.nullable(), data: z.record(z.string(), z.unknown()) });
export const advisoryGroundedFactSchema = z.strictObject({ id: advisoryUuid, identity: advisoryIdentitySchema, workflowId: advisoryUuid, text: advisoryText,
  sourceReference: advisorySourceSchema, evidenceRef: advisoryReferenceSchema, category: z.enum(['DEMO_FEATURE', 'PUBLIC_SERVICE', 'APPROVED_REFERENCE', 'INTERNAL_CUSTOMER_FACT']), visibility: z.enum(['INTERNAL', 'APPROVED_CUSTOMER']), approvalRef: advisoryReferenceSchema.nullable() });
export const advisoryAdviceDraftSchema = z.strictObject({ summary: advisoryText, claims: z.array(z.strictObject({ factId: advisoryUuid, exactQuote: advisoryText, explanation: advisoryText })).min(1).max(15), questions: z.array(advisoryText).max(10), limitations: z.array(advisoryText).min(1).max(10), humanReviewRequired: z.literal(true) });
export type AdvisoryCanonicalParent = z.infer<typeof advisoryCanonicalParentSchema>;
export type AdvisoryGroundedFact = z.infer<typeof advisoryGroundedFactSchema>;
export const advisoryApprovalInputSchema = z.strictObject({ recordRef: advisoryReferenceSchema, validUntil: advisoryTime });
export const advisoryPayloadSchemas = {
  record_value_basis: advisoryValueBasisSchema, record_discovery_answer: advisoryDiscoveryAnswerSchema, register_transcript: advisoryTranscriptSchema,
  review_transcript_assertions: advisoryTranscriptReviewSchema, register_knowledge: advisoryKnowledgeSchema, approve_knowledge: advisoryApprovalInputSchema,
  configure_experiment: advisoryExperimentPlanSchema.extend({ registeredAt: advisoryTime.optional(), eligibilityDigest: advisoryHash.optional(), assignmentSaltDigest: advisoryHash.optional() }), stop_experiment: z.strictObject({ experimentRef: advisoryReferenceSchema, reason: advisoryText }), configure_forecast: advisoryForecastPolicySchema,
  approve_buyer_packet: advisoryApprovalInputSchema, approve_video_storyboard: advisoryApprovalInputSchema, review_advice: z.strictObject({ recordRef: advisoryReferenceSchema, decision: z.enum(['ACCEPTED', 'REJECTED']), reason: advisoryText, publishToBuyer: z.boolean().optional(), buyerQuestionId: advisoryUuid.optional() }).refine(v => !v.publishToBuyer || v.decision === 'ACCEPTED' && v.buyerQuestionId !== undefined, 'ADVISORY_BUYER_PUBLICATION_REQUIRES_ACCEPTED_QUESTION'),
  create_buyer_grant: z.strictObject({ packetRef: advisoryReferenceSchema, tokenHash: advisoryHash, expiresAt: advisoryTime, principalUserId: advisoryUuid }),
  revoke_buyer_grant: z.strictObject({ grantId: advisoryUuid, reason: advisoryText }),
  cancel_advisory_job: z.strictObject({ jobId: advisoryUuid, expectedJobVersion: z.number().int().positive().safe(), reason: advisoryText }),
  prepare_value_case: z.strictObject({ basisRef: advisoryReferenceSchema }), prepare_discovery: z.strictObject({ briefRef: advisoryReferenceSchema, answerRefs: refs }), prepare_buyer_packet: advisoryBuyerPacketInputSchema,
  prepare_advice: advisoryAdviceInputSchema, assess_coaching: z.strictObject({ transcriptRef: advisoryReferenceSchema, knowledgeRef: advisoryReferenceSchema }),
  assign_experiment: z.strictObject({ experimentRef: advisoryReferenceSchema }), prepare_forecast: z.strictObject({ policyRef: advisoryReferenceSchema }),
  prepare_roleplay: advisoryRoleplayInputSchema, prepare_video_storyboard: advisoryVideoInputSchema,
} as const;
export const websiteSalesAdvisoryOwnerOperations = ['record_value_basis', 'record_discovery_answer', 'register_transcript', 'review_transcript_assertions', 'register_knowledge', 'approve_knowledge', 'configure_experiment', 'stop_experiment', 'configure_forecast', 'approve_buyer_packet', 'approve_video_storyboard', 'review_advice', 'create_buyer_grant', 'revoke_buyer_grant', 'cancel_advisory_job'] as const;
export const websiteSalesAdvisoryMachineOperations = ['prepare_value_case', 'prepare_discovery', 'prepare_buyer_packet', 'prepare_advice', 'assess_coaching', 'assign_experiment', 'prepare_forecast', 'prepare_roleplay', 'prepare_video_storyboard'] as const;
export const advisoryOperationSchema = z.enum([...websiteSalesAdvisoryOwnerOperations, ...websiteSalesAdvisoryMachineOperations]);
export const websiteSalesAdvisoryCommandSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), operation: advisoryOperationSchema,
  projectId: advisoryUuid, companyId: advisoryUuid, locationId: advisoryUuid, workflowId: advisoryUuid, expectedVersion: integer, expectedWorkflowVersion: z.number().int().positive().safe(),
  idempotencyKey: z.uuidv4(), correlationId: z.uuidv4(), payload: z.record(z.string(), z.unknown()) }).superRefine((v, ctx) => {
    const grant = z.strictObject({ companyId: advisoryUuid, locationId: advisoryUuid, grantId: advisoryUuid });
    const parsed = advisoryPayloadSchemas[v.operation].safeExtend({ resourceGrants: z.array(grant).max(49).optional() }).safeParse(v.payload);
    if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'ADVISORY_PAYLOAD_INVALID', path: ['payload'] });
    else if (parsed.data.resourceGrants && (new Set(parsed.data.resourceGrants.map(g => `${g.companyId}:${g.locationId}`)).size !== parsed.data.resourceGrants.length || parsed.data.resourceGrants.some(g => g.companyId === v.companyId && g.locationId === v.locationId))) ctx.addIssue({ code: 'custom', message: 'ADVISORY_GRANTS_INVALID', path: ['payload', 'resourceGrants'] });
  });
export type AdvisoryIdentity = z.infer<typeof advisoryIdentitySchema>;
export type AdvisoryReference = z.infer<typeof advisoryReferenceSchema>;
export type AdvisorySource = z.infer<typeof advisorySourceSchema>;
export type WebsiteSalesAdvisoryCommand = z.infer<typeof websiteSalesAdvisoryCommandSchema>;
export const advisoryRecordKindSchema = z.enum(['VALUE_BASIS', 'VALUE_CASE', 'DISCOVERY_ANSWER', 'DISCOVERY_PLAN', 'TRANSCRIPT', 'TRANSCRIPT_ASSERTIONS', 'TRANSCRIPT_REVIEW', 'KNOWLEDGE', 'KNOWLEDGE_APPROVAL', 'EXPERIMENT_PLAN', 'EXPERIMENT_ASSIGNMENT', 'EXPERIMENT_STOP', 'FORECAST_POLICY', 'FORECAST', 'BUYER_PACKET', 'BUYER_PACKET_APPROVAL', 'ADVICE_REQUEST', 'ADVICE', 'ADVICE_REVIEW', 'COACHING', 'ROLEPLAY', 'VIDEO_STORYBOARD', 'VIDEO_APPROVAL']);
export const advisoryRecordSchema = z.strictObject({ id: advisoryUuid, identity: advisoryIdentitySchema, workflowId: advisoryUuid, kind: advisoryRecordKindSchema,
  version: z.number().int().positive().safe(), workflowVersion: z.number().int().positive().safe(), digest: advisoryHash, createdBy: advisoryUuid, createdAt: advisoryTime,
  validUntil: advisoryTime.nullable(), revokedAt: advisoryTime.nullable(), parentRefs: refs, payload: z.record(z.string(), z.unknown()) }).superRefine((v, ctx) => { if (!advisoryRecordPayloadSchemas[v.kind].safeParse(v.payload).success) ctx.addIssue({ code: 'custom', message: 'ADVISORY_RECORD_PAYLOAD_INVALID', path: ['payload'] }); });
export type AdvisoryRecord<T = Record<string, unknown>> = Omit<z.infer<typeof advisoryRecordSchema>, 'payload'> & { payload: T };
export const advisoryChoiceSchema = z.strictObject({ ref: advisoryReferenceSchema, identity: advisoryIdentitySchema, workflowId: advisoryUuid, label: short, status: short });
export const advisoryOfferChoiceSchema = advisoryChoiceSchema.extend({ totalNetMinor: minor, currency: z.literal('EUR'), taxBasis: z.literal('NET') });
export const advisoryPrincipalChoiceSchema = z.strictObject({ userId: advisoryUuid, displayName: short, email: z.email(), sourceDigest: advisoryHash });
export const advisoryReceiptDataSchema = z.strictObject({ identity: advisoryIdentitySchema, workflowId: advisoryUuid, version: integer, workflowVersion: z.number().int().positive().safe(), recordId: advisoryUuid.nullable(), recordDigest: advisoryHash.nullable(), jobId: advisoryUuid.nullable(), canContact: z.literal(false) });
export const websiteSalesAdvisoryReceiptSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), persisted: z.literal(true), commandId: advisoryUuid, auditReference: advisoryText.max(500), correlationId: z.uuidv4(), replayed: z.boolean(), data: advisoryReceiptDataSchema });
export const websiteSalesAdvisoryReadSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), source: z.literal('database'), identity: advisoryIdentitySchema,
  workflowId: advisoryUuid, version: integer, workflowVersion: z.number().int().positive().safe(), canWrite: z.boolean(), canApproveFacts: z.boolean(), canContact: z.literal(false),
  actionEligibility: z.array(z.strictObject({ operation: advisoryOperationSchema, eligible: z.boolean(), blockers: z.array(short).max(20) })).max(30), blockers: z.array(short).max(30), records: z.array(advisoryRecordSchema).max(200),
  choices: z.strictObject({ briefs: z.array(advisoryChoiceSchema).max(20), closePlans: z.array(advisoryChoiceSchema).max(20), demos: z.array(advisoryChoiceSchema).max(20), offers: z.array(advisoryOfferChoiceSchema).max(25), contacts: z.array(advisoryChoiceSchema).max(30), principals: z.array(advisoryPrincipalChoiceSchema).max(30), tasks: z.array(advisoryChoiceSchema).max(30), sources: z.array(advisorySourceSchema).max(100),
    cohortCandidates: z.array(z.strictObject({ label: short, member: advisoryCohortMemberSchema, grantId: advisoryUuid.nullable() })).max(50) }),
  jobs: z.array(z.strictObject({ id: advisoryUuid, version: z.number().int().positive().safe(), kind: z.enum(['ADVICE', 'TRANSCRIPT_ANALYSIS', 'ROLEPLAY', 'VIDEO']), recordRef: advisoryReferenceSchema, status: z.enum(['READY', 'CLAIMED', 'SUCCEEDED', 'UNKNOWN', 'FAILED', 'CANCELLED']), updatedAt: advisoryTime })).max(50),
  buyerGrants: z.array(z.strictObject({ id: advisoryUuid, packetRef: advisoryReferenceSchema, principalUserId: advisoryUuid, expiresAt: advisoryTime, revokedAt: advisoryTime.nullable() })).max(30),
  groundedFacts: z.array(advisoryGroundedFactSchema).max(100), recordStates: z.array(z.strictObject({ recordRef: advisoryReferenceSchema, current: z.boolean(), blockers: z.array(short).max(20) })).max(200),
  coverage: z.strictObject({ historyComplete: z.boolean(), recordsLimit: z.literal(200), hasMore: z.boolean() }),
  buyerQuestions: z.array(z.strictObject({ id: advisoryUuid, grantId: advisoryUuid, packetRef: advisoryReferenceSchema, question: advisoryText, createdAt: advisoryTime, answerRef: advisoryReferenceSchema.nullable() })).max(100) });
export type WebsiteSalesAdvisoryRead = z.infer<typeof websiteSalesAdvisoryReadSchema>;
export const websiteSalesAdvisoryReconcileSchema = z.discriminatedUnion('status', [z.strictObject({ contractVersion: z.literal('website-sales-advisory-reconcile-v1'), status: z.literal('NOT_FOUND'), correlationId: z.uuidv4() }),
  z.strictObject({ contractVersion: z.literal('website-sales-advisory-reconcile-v1'), status: z.literal('COMMITTED'), correlationId: z.uuidv4(), receipt: websiteSalesAdvisoryReceiptSchema, currentData: websiteSalesAdvisoryReadSchema })]);
export const advisoryBuyerValueCaseSchema = z.strictObject({ currency: z.literal('EUR'), amountBasis: z.literal('NET'), scenarioOnly: z.literal(true), roiGuaranteed: z.literal(false), approvedOfferRef: advisoryReferenceSchema, horizonMonths: z.number().int().min(1).max(36),
  scenarios: z.array(z.strictObject({ name: z.enum(['LOW', 'BASE', 'HIGH']), totalCostMinor: minor, totalCashBenefitMinor: minor, netCashMinor: z.number().int().safe(), roiBps: z.number().int().safe().nullable(), paybackMonth: integer.max(36).nullable() })).min(1).max(3) });
export const advisoryBuyerProjectionSchema = z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-v1'), grantId: advisoryUuid, expiresAt: advisoryTime,
  grantVersion: z.number().int().positive().safe(), actorUserId: advisoryUuid.nullable(), actorBindingHash: advisoryHash.nullable(), authAssurance: z.enum(['READ_ONLY_LINK', 'AUTHENTICATED_ACCOUNT']), canWrite: z.boolean(), blockers: z.array(short).max(20), packetRef: advisoryReferenceSchema, title: short, summary: advisoryText, decisionCriteria: z.array(short).max(12),
  options: z.array(z.strictObject({ label: short, benefits: z.array(short).max(8), limits: z.array(short).max(8) })).max(4),
  steps: z.array(z.strictObject({ id: advisoryUuid, version: z.number().int().positive().safe(), label: short, responsible: z.enum(['BUYER', 'NOVALURE']), dueAt: advisoryTime.nullable(), status: z.enum(['PROPOSED', 'CONFIRMED', 'DECLINED', 'DONE']) })).max(15),
  questions: z.array(z.strictObject({ id: advisoryUuid, text: advisoryText, answer: advisoryText.nullable() })).max(30),
  valueCase: advisoryBuyerValueCaseSchema.nullable().default(null),
  demo: z.strictObject({ id: advisoryUuid, title: short, accessPath: z.string().regex(/^\/sales-preview\/[A-Za-z0-9/_-]+$/) }).nullable(),
  video: z.strictObject({ id: advisoryUuid, title: short, mediaPath: z.string().regex(/^\/api\/public\/website-sales\/advisory\/[A-Za-z0-9/_-]+$/), durationSeconds: z.number().positive().max(180), sha256: advisoryHash, captionText: advisoryText.optional() }).nullable() })
  .refine(v => v.canWrite ? v.authAssurance === 'AUTHENTICATED_ACCOUNT' && v.actorUserId !== null && v.actorBindingHash !== null : v.actorUserId === null && v.actorBindingHash === null, 'ADVISORY_BUYER_IDENTITY_REQUIRED');
export type WebsiteSalesAdvisoryBuyerRead = z.infer<typeof advisoryBuyerProjectionSchema>;
export const advisoryBuyerCommandSchema = z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-v1'), grantId: advisoryUuid, expectedGrantVersion: z.number().int().positive().safe(), packetRef: advisoryReferenceSchema, actorBindingHash: advisoryHash,
  stepId: advisoryUuid.nullable(), expectedStepVersion: z.number().int().positive().safe().nullable(), disposition: z.enum(['CONFIRMED', 'DECLINED', 'QUESTION']), comment: advisoryText.max(1000).nullable(), idempotencyKey: z.uuidv4(), correlationId: z.uuidv4() })
  .refine(v => (v.disposition !== 'QUESTION' || v.comment !== null) && (v.stepId === null ? v.expectedStepVersion === null && v.disposition === 'QUESTION' : v.expectedStepVersion !== null), 'ADVISORY_BUYER_STEP_REQUIRED');
export const advisoryBuyerReceiptSchema = z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-v1'), persisted: z.literal(true), commandId: advisoryUuid, auditReference: advisoryText.max(500), correlationId: z.uuidv4(), replayed: z.boolean(),
  data: z.strictObject({ grantId: advisoryUuid, packetRef: advisoryReferenceSchema, actorUserId: advisoryUuid, actorBindingHash: advisoryHash, grantVersion: z.number().int().positive().safe(), stepId: advisoryUuid.nullable(), stepVersion: z.number().int().positive().safe().nullable(), questionId: advisoryUuid.nullable() }) });
export const advisoryBuyerReconcileSchema = z.discriminatedUnion('status', [z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-reconcile-v1'), status: z.literal('NOT_FOUND'), correlationId: z.uuidv4() }),
  z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-reconcile-v1'), status: z.literal('COMMITTED'), correlationId: z.uuidv4(), receipt: advisoryBuyerReceiptSchema, currentData: advisoryBuyerProjectionSchema })]);

const signedMinor = z.number().int().safe(), probability = z.number().finite().min(0).max(1), interval = z.tuple([z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)]);
export interface AdvisoryResult<T> { status: 'READY' | 'NEEDS_CLARIFICATION' | 'INSUFFICIENT_DATA' | 'BLOCKED'; value: T | null; reasons: string[]; externalEffectAllowed: false; requiresServerAuthorization: true }
export function advisoryEvaluationSchema<T extends z.ZodType>(value: T): z.ZodType<AdvisoryResult<z.output<T>>> {
  const schema = z.strictObject({ status: z.enum(['READY', 'NEEDS_CLARIFICATION', 'INSUFFICIENT_DATA', 'BLOCKED']), value: value.nullable(), reasons: z.array(short).max(30), externalEffectAllowed: z.literal(false), requiresServerAuthorization: z.literal(true) }).refine(v => v.status === 'READY' ? Reflect.get(v, 'value') !== null && Reflect.get(v, 'value') !== undefined && v.reasons.length === 0 : v.reasons.length > 0, 'ADVISORY_EVALUATION_INVALID');
  // Zod's generic object mapped type loses the value key for unconstrained T;
  // every concrete nested payload and every safety flag is still parsed above.
  return schema as unknown as z.ZodType<AdvisoryResult<z.output<T>>>;
}
export const advisoryValueCaseValueSchema = z.strictObject({ basisRef: advisoryReferenceSchema, currency: z.literal('EUR'), amountBasis: z.literal('NET'), scenarioOnly: z.literal(true), roiGuaranteed: z.literal(false),
  scenarios: z.array(z.strictObject({ name: z.enum(['LOW', 'BASE', 'HIGH']), assumption: advisoryText, monthlyCashBenefitMinor: minor, monthlyCapacityValueMinor: minor, totalCostMinor: minor, totalCashBenefitMinor: minor, netCashMinor: signedMinor, roiBps: signedMinor.nullable(), paybackMonth: integer.max(36).nullable(),
    cashflow: z.array(z.strictObject({ month: integer.max(36), costMinor: minor, cashBenefitMinor: minor, netMinor: signedMinor, cumulativeNetMinor: signedMinor })).max(37), sourceIds: z.array(advisoryUuid).max(260) })).min(1).max(3), limitations: z.array(advisoryText).min(1).max(10) });
export const advisoryDiscoveryPlanValueSchema = z.strictObject({ briefRef: advisoryReferenceSchema, answerRefs: refs, missingKinds: z.array(advisoryDiscoveryAnswerSchema.shape.kind).max(4),
  questions: z.array(z.strictObject({ id: short, kind: advisoryDiscoveryAnswerSchema.shape.kind, text: advisoryText })).max(4), recordedNeeds: z.array(z.strictObject({ answerRef: advisoryReferenceSchema, text: advisoryText })).max(40), humanConfirmationRequired: z.literal(true) });
export const advisoryBuyerPacketValueSchema = advisoryBuyerPacketInputSchema.extend({ summary: advisoryText, publication: z.literal('DRAFT_REQUIRES_APPROVAL') });
export const advisoryAdviceValueSchema = advisoryAdviceDraftSchema.extend({ requestDigest: advisoryHash, factDigest: advisoryHash, factRefs: refs, buyerQuestionId: advisoryUuid.nullable(), status: z.literal('DRAFT_REQUIRES_REVIEW') });
export const advisoryTranscriptAssertionsValueSchema = z.strictObject({ transcriptRef: advisoryReferenceSchema, assertions: z.array(advisoryAssertionSchema).max(30), humanReviewRequired: z.literal(true), canonicalFactsChanged: z.literal(false) });
export const advisoryCoachingValueSchema = z.strictObject({ transcriptRef: advisoryReferenceSchema, knowledgeRef: advisoryReferenceSchema, findings: z.array(z.strictObject({ criterionId: short, label: short, status: z.enum(['POSSIBLE_EVIDENCE', 'NOT_OBSERVED']), evidence: z.array(z.strictObject({ segmentId: advisoryUuid, exactQuote: advisoryText })).max(3) })).max(12), humanReviewRequired: z.literal(true), performanceScore: z.null() });
export const advisoryRoleplayValueSchema = z.strictObject({ knowledgeRef: advisoryReferenceSchema, scenarioId: short, situation: advisoryText, customerOpening: advisoryText, rubric: z.array(z.strictObject({ id: short, label: short })).max(12), simulationOnly: z.literal(true), customerContactAllowed: z.literal(false), previousRoleplayRef: advisoryReferenceSchema.nullable().optional(), sellerReply: advisoryText.nullable().optional(), customerReply: advisoryText.optional(), status: z.literal('SIMULATION_ONLY').optional() })
  .refine(v => v.customerReply === undefined ? v.previousRoleplayRef === undefined && v.sellerReply === undefined && v.status === undefined : v.status === 'SIMULATION_ONLY' && (v.previousRoleplayRef === null ? v.sellerReply === null : v.previousRoleplayRef !== undefined && v.sellerReply !== undefined && v.sellerReply !== null), 'ADVISORY_ROLEPLAY_TURN_INVALID');
export const advisoryVideoStoryboardValueSchema = z.strictObject({ title: short, language: z.enum(['de', 'en']), demoRef: advisoryReferenceSchema, packetRef: advisoryReferenceSchema.nullable(), assetRefs: refs, maximumSeconds: z.number().int().min(20).max(180),
  shots: z.array(z.strictObject({ index: integer.max(2), durationSeconds: z.number().int().min(1).max(180), narration: advisoryText, factId: advisoryUuid, evidenceRef: advisoryReferenceSchema, visual: z.literal('PROTECTED_DEMO_CAPTURE'), demoRef: advisoryReferenceSchema })).min(1).max(3),
  sourceBindingDigest: advisoryHash, status: z.literal('STORYBOARD_REQUIRES_APPROVAL'), customerSecretsIncluded: z.literal(false), renderedVideo: z.literal(false) });
export const advisoryExperimentAssignmentValueSchema = z.strictObject({ planRef: advisoryReferenceSchema, unitKey: short, arm: z.enum(['CONTROL', 'VARIANT']), treatmentRef: advisoryReferenceSchema, assignedAt: advisoryTime, eligibilityDigest: advisoryHash, assignmentSaltDigest: advisoryHash, cohortSourceDigest: advisoryHash });
export const advisoryExperimentAssessmentValueSchema = z.strictObject({ planRef: advisoryReferenceSchema, unit: z.literal('WORKSPACE_COMPANY'), analysis: z.literal('INTENTION_TO_TREAT'), horizonDays: z.number().int().min(1).max(365), enrollmentClosed: z.boolean(), stopped: z.boolean(),
  arms: z.array(z.strictObject({ arm: z.enum(['CONTROL', 'VARIANT']), assigned: integer.max(50), wins: integer.max(50), known: integer.max(50), pending: integer.max(50), unknown: integer.max(50), rate: probability.nullable(), bounds: interval, wilson95: interval.nullable() })).length(2), effectBounds: interval, difference95: interval.nullable(), promotion: z.literal('REVIEW_REQUIRED'), automaticallyPromoted: z.literal(false) });
export const advisoryForecastValueSchema = z.strictObject({ policyRef: advisoryReferenceSchema, validationMode: z.enum(['PREREGISTERED_TIME_HOLDOUT', 'RETROSPECTIVE_TIME_HOLDOUT']), postHocPolicySelection: z.boolean(), prospectiveValidation: z.literal(false), basis: z.enum(['EMPIRICAL', 'INSUFFICIENT_DATA']), probability: probability.nullable(), interval95: interval.nullable(), horizonDays: z.number().int().min(1).max(365), training: z.strictObject({ n: integer.max(50), wins: integer.max(50) }),
  holdout: z.strictObject({ n: integer.max(50), wins: integer.max(50), brier: probability.nullable(), baselineBrier: probability.nullable(), calibration: z.array(z.strictObject({ n: integer.max(50), meanPrediction: probability, observedRate: probability, observedWilson95: interval })).max(10) }),
  excluded: z.strictObject({ pending: integer.max(50), unknown: integer.max(50), outsideWindow: integer.max(50) }), dataDigest: advisoryHash, promotion: z.literal('REVIEW_REQUIRED') }).refine(v => v.basis === 'EMPIRICAL' ? v.probability !== null && v.interval95 !== null : v.probability === null && v.interval95 === null, 'ADVISORY_FORECAST_PROBABILITY_INVALID');
export const advisoryRecordPayloadSchemas = {
  VALUE_BASIS: advisoryValueBasisSchema, VALUE_CASE: advisoryEvaluationSchema(advisoryValueCaseValueSchema), DISCOVERY_ANSWER: advisoryDiscoveryAnswerSchema, DISCOVERY_PLAN: advisoryEvaluationSchema(advisoryDiscoveryPlanValueSchema), TRANSCRIPT: advisoryTranscriptSchema,
  TRANSCRIPT_ASSERTIONS: advisoryEvaluationSchema(advisoryTranscriptAssertionsValueSchema), TRANSCRIPT_REVIEW: advisoryTranscriptReviewSchema, KNOWLEDGE: advisoryKnowledgeSchema, KNOWLEDGE_APPROVAL: advisoryApprovalInputSchema,
  EXPERIMENT_PLAN: advisoryExperimentPlanSchema, EXPERIMENT_ASSIGNMENT: advisoryEvaluationSchema(advisoryExperimentAssignmentValueSchema), EXPERIMENT_STOP: advisoryPayloadSchemas.stop_experiment,
  FORECAST_POLICY: advisoryForecastPolicySchema, FORECAST: advisoryEvaluationSchema(advisoryForecastValueSchema), BUYER_PACKET: advisoryEvaluationSchema(advisoryBuyerPacketValueSchema), BUYER_PACKET_APPROVAL: advisoryApprovalInputSchema,
  ADVICE_REQUEST: advisoryAdviceInputSchema, ADVICE: advisoryEvaluationSchema(advisoryAdviceValueSchema), ADVICE_REVIEW: advisoryPayloadSchemas.review_advice, COACHING: advisoryEvaluationSchema(advisoryCoachingValueSchema), ROLEPLAY: advisoryEvaluationSchema(advisoryRoleplayValueSchema),
  VIDEO_STORYBOARD: advisoryEvaluationSchema(advisoryVideoStoryboardValueSchema), VIDEO_APPROVAL: advisoryApprovalInputSchema,
} as const;

/** Identity validation is usable by browser clients; hashing and admission stay server-side. */
export function validateWebsiteSalesAdvisoryRead(raw: unknown, identity: AdvisoryIdentity, workflowId: string, authorizedResources?: readonly { identity: AdvisoryIdentity; workflowId: string }[]): WebsiteSalesAdvisoryRead {
  const value = websiteSalesAdvisoryReadSchema.parse(raw), expected = advisoryIdentitySchema.parse(identity);
  const equal = (a: AdvisoryIdentity) => Object.keys(expected).every(k => a[k as keyof AdvisoryIdentity] === expected[k as keyof AdvisoryIdentity]);
  if (!equal(value.identity) || value.workflowId !== workflowId || [...value.records, ...value.choices.briefs, ...value.choices.closePlans, ...value.choices.demos, ...value.choices.offers, ...value.choices.contacts, ...value.choices.tasks].some(r => !equal(r.identity) || r.workflowId !== workflowId) || value.choices.cohortCandidates.some(c => c.member.identity.workspaceId !== expected.workspaceId || c.member.identity.projectId !== expected.projectId)) throw Error('ADVISORY_READ_SCOPE_DENIED');
  if (value.groundedFacts.some(f => !equal(f.identity) || f.workflowId !== workflowId) || value.records.some(r => !value.recordStates.some(s => s.recordRef.id === r.id && s.recordRef.version === r.version && s.recordRef.digest === r.digest)) || new Set(value.recordStates.map(s => `${s.recordRef.id}:${s.recordRef.version}`)).size !== value.recordStates.length || value.recordStates.some(s => !value.records.some(r => r.id === s.recordRef.id && r.version === s.recordRef.version && r.digest === s.recordRef.digest))) throw Error('ADVISORY_READ_BINDING_INVALID');
  const cohort = [...value.choices.cohortCandidates.map(c => c.member), ...value.records.flatMap(r => r.kind === 'EXPERIMENT_PLAN' ? advisoryExperimentPlanSchema.parse(r.payload).cohort : r.kind === 'FORECAST_POLICY' ? advisoryForecastPolicySchema.parse(r.payload).cohort : [])];
  if (cohort.some(c => c.identity.workspaceId !== expected.workspaceId || c.identity.projectId !== expected.projectId || authorizedResources !== undefined && !(equal(c.identity) && c.workflowId === workflowId) && !authorizedResources.some(a => a.workflowId === c.workflowId && Object.keys(expected).every(k => a.identity[k as keyof AdvisoryIdentity] === c.identity[k as keyof AdvisoryIdentity])))) throw Error('ADVISORY_READ_RESOURCE_SCOPE_DENIED');
  return value;
}
