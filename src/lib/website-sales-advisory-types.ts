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
export const advisoryValueBasisSchema = z.strictObject({ title: short, offerRef: advisoryReferenceSchema, currency: z.literal('EUR'), amountBasis: z.literal('NET'),
  horizonMonths: z.number().int().min(1).max(36), oneTimeCostMinor: minor, monthlyCostMinor: minor,
  scenarios: z.array(z.strictObject({ name: z.enum(['LOW', 'BASE', 'HIGH']), monthlyBenefitMinor: minor, startsAtMonth: z.number().int().min(1).max(36),
    assumption: advisoryText, sourceReferences: sources })).min(1).max(3), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryDiscoveryAnswerSchema = z.strictObject({ briefRef: advisoryReferenceSchema, questionId: short,
  kind: z.enum(['SITUATION', 'PROBLEM', 'IMPLICATION', 'NEED_PAYOFF']), answer: advisoryText, sourceReferences: sources, validUntil: advisoryTime });
export const advisoryTranscriptSegmentSchema = z.strictObject({ id: advisoryUuid, speaker: z.enum(['CUSTOMER', 'SELLER', 'OTHER']), startMs: integer.max(14_400_000), endMs: integer.max(14_400_000), text: advisoryText.max(1000) }).refine(v => v.endMs > v.startMs, 'ADVISORY_SEGMENT_TIME_INVALID');
export const advisoryTranscriptSchema = z.strictObject({ title: short, segments: z.array(advisoryTranscriptSegmentSchema).min(1).max(90),
  permissionReference: advisorySourceSchema, sourceReferences: sources, validUntil: advisoryTime });
export const advisoryAssertionSchema = z.strictObject({ id: advisoryUuid, text: advisoryText, segmentIds: z.array(advisoryUuid).min(1).max(10), exactQuotes: z.array(advisoryText.max(1000)).min(1).max(10), kind: z.enum(['NEED', 'CONSTRAINT', 'QUESTION', 'POSSIBLE_COMMITMENT']) });
export const advisoryTranscriptReviewSchema = z.strictObject({ transcriptRef: advisoryReferenceSchema, analysisRef: advisoryReferenceSchema,
  decisions: z.array(z.strictObject({ assertionId: advisoryUuid, decision: z.enum(['ACCEPTED_AS_RECORDED', 'REJECTED']), reason: advisoryText })).min(1).max(30) });
export const advisoryKnowledgeSchema = z.strictObject({ title: short, kind: z.enum(['PLAYBOOK', 'RUBRIC', 'ROLEPLAY']), content: advisoryText,
  disclosure: z.enum(['INTERNAL', 'CUSTOMER_APPROVAL_REQUIRED']), rightsReference: advisorySourceSchema,
  criteria: z.array(z.strictObject({ id: short, label: short, evidenceTerms: z.array(short).min(1).max(10) })).max(12),
  scenarios: z.array(z.strictObject({ id: short, situation: advisoryText, customerOpening: advisoryText })).max(12), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryExperimentPlanSchema = z.strictObject({ title: short, hypothesis: advisoryText, metric: z.literal('WON_WITHIN_HORIZON'),
  horizonDays: z.number().int().min(1).max(365), registeredAt: advisoryTime, enrollmentEndsAt: advisoryTime,
  maximumCompanies: z.number().int().min(2).max(10000), minimumPerArm: z.number().int().min(1).max(5000), maximumUnknownBps: integer.max(10000),
  controlRef: advisoryReferenceSchema, variantRef: advisoryReferenceSchema, eligibilityDigest: advisoryHash, assignmentSaltDigest: advisoryHash,
  cohort: z.array(advisoryCohortMemberSchema).min(2).max(50), sourceReferences: sources, promotion: z.literal('REVIEW_REQUIRED') });
export const advisoryForecastPolicySchema = z.strictObject({ title: short, horizonDays: z.number().int().min(1).max(365), segmentKey: short,
  treatmentDigest: advisoryHash, trainEndsAt: advisoryTime, holdoutStartsAt: advisoryTime, holdoutEndsAt: advisoryTime,
  minimumTrain: z.number().int().min(10).max(10000), minimumHoldout: z.number().int().min(5).max(10000), minimumClassCount: z.number().int().min(1).max(1000),
  maximumIntervalWidthBps: integer.max(10000), maximumBrierBps: integer.max(10000), cohort: z.array(advisoryCohortMemberSchema).min(1).max(50), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryBuyerStepSchema = z.strictObject({ id: advisoryUuid, label: short, responsible: z.enum(['BUYER', 'NOVALURE']), dueAt: advisoryTime.nullable(),
  basis: z.enum(['INTERNAL_PROPOSAL', 'CUSTOMER_AGREEMENT_RECORDED']), sourceReferences: sources });
export const advisoryBuyerPacketInputSchema = z.strictObject({ title: short, briefRef: advisoryReferenceSchema, closePlanRef: advisoryReferenceSchema.nullable(), valueCaseRef: advisoryReferenceSchema.nullable(),
  demoRefs: refs, decisionCriteria: z.array(short).min(1).max(12), options: z.array(z.strictObject({ label: short, benefits: z.array(short).max(8), limits: z.array(short).max(8) })).min(1).max(4),
  steps: z.array(advisoryBuyerStepSchema).max(15), sourceReferences: sources, validUntil: advisoryTime });
export const advisoryAdviceInputSchema = z.strictObject({ kind: z.enum(['WEBSITE', 'DEMO']), question: advisoryText, factRefs: refs.min(1), artifactRefs: refs, knowledgeRefs: refs });
export const advisoryVideoInputSchema = z.strictObject({ demoRef: advisoryReferenceSchema, packetRef: advisoryReferenceSchema.nullable(), title: short,
  language: z.enum(['de', 'en']), maximumSeconds: z.number().int().min(20).max(180), goal: advisoryText, assetRefs: refs });
export const advisoryApprovalInputSchema = z.strictObject({ recordRef: advisoryReferenceSchema, validUntil: advisoryTime });
export const advisoryPayloadSchemas = {
  record_value_basis: advisoryValueBasisSchema, record_discovery_answer: advisoryDiscoveryAnswerSchema, register_transcript: advisoryTranscriptSchema,
  review_transcript_assertions: advisoryTranscriptReviewSchema, register_knowledge: advisoryKnowledgeSchema, approve_knowledge: advisoryApprovalInputSchema,
  configure_experiment: advisoryExperimentPlanSchema, stop_experiment: z.strictObject({ experimentRef: advisoryReferenceSchema, reason: advisoryText }), configure_forecast: advisoryForecastPolicySchema,
  approve_buyer_packet: advisoryApprovalInputSchema, approve_video_storyboard: advisoryApprovalInputSchema, review_advice: z.strictObject({ recordRef: advisoryReferenceSchema, decision: z.enum(['ACCEPTED', 'REJECTED']), reason: advisoryText }),
  create_buyer_grant: z.strictObject({ packetRef: advisoryReferenceSchema, tokenHash: advisoryHash, expiresAt: advisoryTime, principalUserId: advisoryUuid }),
  revoke_buyer_grant: z.strictObject({ grantId: advisoryUuid, reason: advisoryText }),
  prepare_value_case: z.strictObject({ basisRef: advisoryReferenceSchema }), prepare_discovery: z.strictObject({ briefRef: advisoryReferenceSchema, answerRefs: refs }), prepare_buyer_packet: advisoryBuyerPacketInputSchema,
  prepare_advice: advisoryAdviceInputSchema, assess_coaching: z.strictObject({ transcriptRef: advisoryReferenceSchema, knowledgeRef: advisoryReferenceSchema }),
  assign_experiment: z.strictObject({ experimentRef: advisoryReferenceSchema }), prepare_forecast: z.strictObject({ policyRef: advisoryReferenceSchema }),
  prepare_roleplay: z.strictObject({ knowledgeRef: advisoryReferenceSchema, scenarioId: short }), prepare_video_storyboard: advisoryVideoInputSchema,
} as const;
export const websiteSalesAdvisoryOwnerOperations = ['record_value_basis', 'record_discovery_answer', 'register_transcript', 'review_transcript_assertions', 'register_knowledge', 'approve_knowledge', 'configure_experiment', 'stop_experiment', 'configure_forecast', 'approve_buyer_packet', 'approve_video_storyboard', 'review_advice', 'create_buyer_grant', 'revoke_buyer_grant'] as const;
export const websiteSalesAdvisoryMachineOperations = ['prepare_value_case', 'prepare_discovery', 'prepare_buyer_packet', 'prepare_advice', 'assess_coaching', 'assign_experiment', 'prepare_forecast', 'prepare_roleplay', 'prepare_video_storyboard'] as const;
export const advisoryOperationSchema = z.enum([...websiteSalesAdvisoryOwnerOperations, ...websiteSalesAdvisoryMachineOperations]);
export const websiteSalesAdvisoryCommandSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), operation: advisoryOperationSchema,
  projectId: advisoryUuid, companyId: advisoryUuid, locationId: advisoryUuid, workflowId: advisoryUuid, expectedVersion: integer, expectedWorkflowVersion: z.number().int().positive().safe(),
  idempotencyKey: z.uuidv4(), correlationId: z.uuidv4(), payload: z.record(z.string(), z.unknown()) }).superRefine((v, ctx) => {
    const grant = z.strictObject({ companyId: advisoryUuid, locationId: advisoryUuid, grantId: advisoryUuid });
    const parsed = advisoryPayloadSchemas[v.operation].extend({ resourceGrants: z.array(grant).max(49).optional() }).safeParse(v.payload);
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
  validUntil: advisoryTime.nullable(), revokedAt: advisoryTime.nullable(), parentRefs: refs, payload: z.record(z.string(), z.unknown()) });
export type AdvisoryRecord<T = Record<string, unknown>> = Omit<z.infer<typeof advisoryRecordSchema>, 'payload'> & { payload: T };
export const advisoryChoiceSchema = z.strictObject({ ref: advisoryReferenceSchema, identity: advisoryIdentitySchema, workflowId: advisoryUuid, label: short, status: short });
export const advisoryReceiptDataSchema = z.strictObject({ identity: advisoryIdentitySchema, workflowId: advisoryUuid, version: integer, workflowVersion: z.number().int().positive().safe(), recordId: advisoryUuid.nullable(), recordDigest: advisoryHash.nullable(), jobId: advisoryUuid.nullable(), canContact: z.literal(false) });
export const websiteSalesAdvisoryReceiptSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), persisted: z.literal(true), commandId: advisoryUuid, auditReference: advisoryText.max(500), correlationId: z.uuidv4(), replayed: z.boolean(), data: advisoryReceiptDataSchema });
export const websiteSalesAdvisoryReadSchema = z.strictObject({ contractVersion: z.literal(websiteSalesAdvisoryContract), source: z.literal('database'), identity: advisoryIdentitySchema,
  workflowId: advisoryUuid, version: integer, workflowVersion: z.number().int().positive().safe(), canWrite: z.boolean(), canApproveFacts: z.boolean(), canContact: z.literal(false),
  actionEligibility: z.array(z.strictObject({ operation: advisoryOperationSchema, eligible: z.boolean(), blockers: z.array(short).max(20) })).max(30), blockers: z.array(short).max(30), records: z.array(advisoryRecordSchema).max(200),
  choices: z.strictObject({ briefs: z.array(advisoryChoiceSchema).max(20), closePlans: z.array(advisoryChoiceSchema).max(20), demos: z.array(advisoryChoiceSchema).max(20), contacts: z.array(advisoryChoiceSchema).max(30), principals: z.array(advisoryChoiceSchema).max(30), tasks: z.array(advisoryChoiceSchema).max(30), sources: z.array(advisorySourceSchema).max(100) }),
  jobs: z.array(z.strictObject({ id: advisoryUuid, kind: z.enum(['ADVICE', 'TRANSCRIPT_ANALYSIS', 'VIDEO']), recordRef: advisoryReferenceSchema, status: z.enum(['READY', 'CLAIMED', 'SUCCEEDED', 'UNKNOWN', 'FAILED', 'CANCELLED']), updatedAt: advisoryTime })).max(50),
  buyerGrants: z.array(z.strictObject({ id: advisoryUuid, packetRef: advisoryReferenceSchema, principalUserId: advisoryUuid, expiresAt: advisoryTime, revokedAt: advisoryTime.nullable() })).max(30) });
export type WebsiteSalesAdvisoryRead = z.infer<typeof websiteSalesAdvisoryReadSchema>;
export const websiteSalesAdvisoryReconcileSchema = z.discriminatedUnion('status', [z.strictObject({ contractVersion: z.literal('website-sales-advisory-reconcile-v1'), status: z.literal('NOT_FOUND'), correlationId: z.uuidv4() }),
  z.strictObject({ contractVersion: z.literal('website-sales-advisory-reconcile-v1'), status: z.literal('COMMITTED'), correlationId: z.uuidv4(), receipt: websiteSalesAdvisoryReceiptSchema, currentData: websiteSalesAdvisoryReadSchema })]);
export const advisoryBuyerProjectionSchema = z.strictObject({ contractVersion: z.literal('website-sales-advisory-buyer-v1'), grantId: advisoryUuid, expiresAt: advisoryTime,
  canWrite: z.boolean(), blockers: z.array(short).max(20), packetRef: advisoryReferenceSchema, title: short, summary: advisoryText, decisionCriteria: z.array(short).max(12),
  options: z.array(z.strictObject({ label: short, benefits: z.array(short).max(8), limits: z.array(short).max(8) })).max(4),
  steps: z.array(z.strictObject({ id: advisoryUuid, label: short, responsible: z.enum(['BUYER', 'NOVALURE']), dueAt: advisoryTime.nullable(), status: z.enum(['PROPOSED', 'CONFIRMED', 'DONE']) })).max(15),
  questions: z.array(z.strictObject({ id: advisoryUuid, text: advisoryText, answer: advisoryText.nullable() })).max(30),
  demo: z.strictObject({ id: advisoryUuid, title: short, accessPath: z.string().regex(/^\/sales-preview\/[A-Za-z0-9/_-]+$/) }).nullable(),
  video: z.strictObject({ id: advisoryUuid, title: short, mediaPath: z.string().regex(/^\/api\/public\/website-sales\/advisory\/[A-Za-z0-9/_-]+$/), durationSeconds: z.number().positive().max(180), sha256: advisoryHash }).nullable() });
export type WebsiteSalesAdvisoryBuyerRead = z.infer<typeof advisoryBuyerProjectionSchema>;

/** Identity validation is usable by browser clients; hashing and admission stay server-side. */
export function validateWebsiteSalesAdvisoryRead(raw: unknown, identity: AdvisoryIdentity, workflowId: string): WebsiteSalesAdvisoryRead {
  const value = websiteSalesAdvisoryReadSchema.parse(raw), expected = advisoryIdentitySchema.parse(identity);
  const equal = (a: AdvisoryIdentity) => Object.keys(expected).every(k => a[k as keyof AdvisoryIdentity] === expected[k as keyof AdvisoryIdentity]);
  if (!equal(value.identity) || value.workflowId !== workflowId || [...value.records, ...value.choices.briefs, ...value.choices.closePlans, ...value.choices.demos, ...value.choices.contacts, ...value.choices.principals, ...value.choices.tasks].some(r => !equal(r.identity) || r.workflowId !== workflowId)) throw Error('ADVISORY_READ_SCOPE_DENIED');
  return value;
}
