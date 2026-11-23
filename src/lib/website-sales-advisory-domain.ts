import { createHash } from 'node:crypto';
import { z } from 'zod';
import { advisoryIdentitySchema, advisoryRecordSchema, advisoryValueBasisSchema, advisoryDiscoveryAnswerSchema, advisoryCanonicalParentSchema, advisoryGroundedFactSchema, advisoryBuyerPacketInputSchema, advisoryAdviceInputSchema, advisoryAdviceDraftSchema, advisoryTranscriptSchema, advisoryAssertionSchema, advisoryTranscriptReviewSchema, advisoryTranscriptAssertionsValueSchema, advisoryEvaluationSchema, advisoryKnowledgeSchema, advisoryApprovalInputSchema, advisoryVideoInputSchema,
  type AdvisoryIdentity, type AdvisoryRecord, type AdvisoryReference, type AdvisorySource, type AdvisoryCanonicalParent, type AdvisoryGroundedFact } from './website-sales-advisory-types';

export interface AdvisoryContext { identity: AdvisoryIdentity; workflowId: string; workflowVersion: number; authorizedResources?: readonly { identity: AdvisoryIdentity; workflowId: string; workflowVersion: number }[] }
export interface AdvisoryEvaluation<T> { status: 'READY' | 'NEEDS_CLARIFICATION' | 'INSUFFICIENT_DATA' | 'BLOCKED'; value: T | null; reasons: string[]; externalEffectAllowed: false; requiresServerAuthorization: true }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
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
export function verifyAdvisoryPeerRecord(raw: unknown, ctx: AdvisoryContext, nowISO: string): AdvisoryRecord {
  const row = advisoryRecordSchema.parse(raw);
  if (advisoryDigest(row.identity) === advisoryDigest(ctx.identity) && row.workflowId === ctx.workflowId) return verifyAdvisoryRecord(row, ctx, nowISO);
  const grant = ctx.authorizedResources?.find(r => advisoryDigest(r.identity) === advisoryDigest(row.identity) && r.workflowId === row.workflowId);
  if (!grant || grant.identity.workspaceId !== ctx.identity.workspaceId || grant.identity.projectId !== ctx.identity.projectId) throw Error('ADVISORY_PEER_SCOPE_DENIED');
  return verifyAdvisoryRecord(row, { ...grant }, nowISO);
}
function outcome<T>(value: T | null, reasons: string[] = [], status: AdvisoryEvaluation<T>['status'] = 'BLOCKED'): AdvisoryEvaluation<T> { return { status: reasons.length ? status : 'READY', value, reasons, externalEffectAllowed: false, requiresServerAuthorization: true }; }
function guarded<T>(run: () => AdvisoryEvaluation<T>): AdvisoryEvaluation<T> { try { return run(); } catch (e) { return outcome<T>(null, [e instanceof Error && /^ADVISORY_[A-Z_]+$/.test(e.message) ? e.message : 'ADVISORY_INPUT_INVALID']); } }
function requireRule(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code); }
function sameRef(a: AdvisoryReference, b: AdvisoryReference) { return advisoryDigest(a) === advisoryDigest(b); }
function currentSources(rows: AdvisorySource[], nowISO: string) { const now = Date.parse(nowISO); requireRule(Number.isFinite(now) && rows.length > 0 && rows.every(r => Date.parse(r.observedAt) <= now && Date.parse(r.validUntil) > now), 'ADVISORY_SOURCES_NOT_CURRENT'); }
function readRecord<T extends z.ZodType>(raw: AdvisoryRecord, kind: AdvisoryRecord['kind'], schema: T, ctx: AdvisoryContext, now: string) { const row = verifyAdvisoryRecord(raw, ctx, now); requireRule(row.kind === kind, 'ADVISORY_RECORD_KIND_MISMATCH'); return { ...row, payload: schema.parse(row.payload) }; }
function parent(raw: AdvisoryCanonicalParent, kind: AdvisoryCanonicalParent['kind'], ctx: AdvisoryContext, now: string) {
  const p = advisoryCanonicalParentSchema.parse(raw); requireRule(p.kind === kind && advisoryDigest(p.identity) === advisoryDigest(ctx.identity) && p.workflowId === ctx.workflowId && p.workflowVersion <= ctx.workflowVersion && !p.revokedAt && (!p.validUntil || Date.parse(p.validUntil) > Date.parse(now)), 'ADVISORY_CANONICAL_PARENT_NOT_CURRENT'); return p;
}
function facts(raw: AdvisoryGroundedFact[], ctx: AdvisoryContext, now: string) { requireRule(raw.length <= 100, 'ADVISORY_FACT_LIMIT'); const rows = raw.map(r => advisoryGroundedFactSchema.parse(r)); requireRule(new Set(rows.map(r => r.id)).size === rows.length && rows.every(r => advisoryDigest(r.identity) === advisoryDigest(ctx.identity) && r.workflowId === ctx.workflowId), 'ADVISORY_FACT_SCOPE_DENIED'); rows.forEach(r => currentSources([r.sourceReference], now)); return rows; }
const maxMoney = BigInt(Number.MAX_SAFE_INTEGER);
function money(value: bigint) { requireRule(value >= -maxMoney && value <= maxMoney, 'ADVISORY_MONEY_OVERFLOW'); return Number(value); }
const rounded = (num: bigint, den: bigint) => (num + den / BigInt(2)) / den;
/** Decimal strings avoid binary floating-point conversion of customer amounts. */
export function parseAdvisoryDecimal(value: string, scale: number): number {
  requireRule(Number.isInteger(scale) && scale >= 0 && scale <= 6 && new RegExp(`^\\d{1,12}(?:\\.\\d{1,${Math.max(1, scale)}})?$`).test(value) && (scale > 0 || !value.includes('.')), 'ADVISORY_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return money(BigInt(whole!) * BigInt(10 ** scale) + BigInt(fraction.padEnd(scale, '0') || '0'));
}
export function calculateAdvisoryValueCase(raw: AdvisoryRecord, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const row = readRecord(raw, 'VALUE_BASIS', advisoryValueBasisSchema, ctx, nowISO), basis = row.payload; currentSources(basis.sourceReferences, nowISO);
    requireRule(new Set(basis.scenarios.map(s => s.name)).size === basis.scenarios.length, 'ADVISORY_SCENARIO_DUPLICATE');
    const scenarios = basis.scenarios.map(s => {
      currentSources(s.sourceReferences, nowISO); requireRule(s.startsAtMonth <= basis.horizonMonths, 'ADVISORY_SCENARIO_HORIZON_INVALID');
      let benefit = BigInt(s.monthlyBenefitMinor ?? 0), capacity = BigInt(0);
      const components = s.components ?? []; requireRule(new Set(components.map(c => c.effectKey)).size === components.length && new Set(components.map(c => c.id)).size === components.length, 'ADVISORY_BENEFIT_DOUBLE_COUNT');
      for (const c of components) { currentSources(c.sourceReferences, nowISO); const amount = c.kind === 'CONTRIBUTION' ? rounded(BigInt(parseAdvisoryDecimal(c.additionalOrdersDecimal, 3)) * BigInt(c.contributionPerOrderMinor), BigInt(1000)) : rounded(BigInt(c.minutesPerMonth) * BigInt(c.hourlyCostMinor), BigInt(60)); if (c.kind === 'TIME_SAVING' && c.treatment === 'CAPACITY_ONLY') capacity += amount; else benefit += amount; }
      let cumulative = -BigInt(basis.oneTimeCostMinor), totalCost = BigInt(basis.oneTimeCostMinor), totalBenefit = BigInt(0); let paybackMonth: number | null = null;
      const cashflow = [{ month: 0, costMinor: basis.oneTimeCostMinor, cashBenefitMinor: 0, netMinor: money(cumulative), cumulativeNetMinor: money(cumulative) }];
      for (let month = 1; month <= basis.horizonMonths; month++) { const b = month >= s.startsAtMonth ? benefit : BigInt(0), cost = BigInt(basis.monthlyCostMinor); totalCost += cost; totalBenefit += b; cumulative += b - cost; if (paybackMonth === null && totalCost > BigInt(0) && cumulative >= BigInt(0)) paybackMonth = month; cashflow.push({ month, costMinor: basis.monthlyCostMinor, cashBenefitMinor: money(b), netMinor: money(b - cost), cumulativeNetMinor: money(cumulative) }); }
      const net = totalBenefit - totalCost; return { name: s.name, assumption: s.assumption, monthlyCashBenefitMinor: money(benefit), monthlyCapacityValueMinor: money(capacity), totalCostMinor: money(totalCost), totalCashBenefitMinor: money(totalBenefit), netCashMinor: money(net), roiBps: totalCost === BigInt(0) ? null : money(net * BigInt(10000) / totalCost), paybackMonth, cashflow, sourceIds: [...new Set([...basis.sourceReferences, ...s.sourceReferences, ...components.flatMap(c => c.sourceReferences)].map(r => r.id))] };
    });
    return outcome({ basisRef: advisoryReference(row), currency: 'EUR' as const, amountBasis: 'NET' as const, scenarioOnly: true as const, roiGuaranteed: false as const, scenarios, limitations: ['Customer-sourced assumptions are scenarios, not a revenue or ROI guarantee.', 'Capacity-only time savings are excluded from cash benefits.', 'Cash flows are undiscounted; no interest, tax or growth is assumed.'] });
  });
}
export function planAdvisoryDiscovery(input: { brief: AdvisoryCanonicalParent; answers: AdvisoryRecord[] }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const brief = parent(input.brief, 'BRIEF', ctx, nowISO), body = z.object({ goals: z.array(z.string()).max(30), audience: z.array(z.string()).max(30), services: z.array(z.string()).max(30), sourceReferences: z.array(z.unknown()).optional() }).parse(brief.data);
    requireRule(input.answers.length <= 40, 'ADVISORY_ANSWER_LIMIT'); const answers = input.answers.map(r => readRecord(r, 'DISCOVERY_ANSWER', advisoryDiscoveryAnswerSchema, ctx, nowISO));
    answers.forEach(r => { requireRule(sameRef(r.payload.briefRef, brief.reference), 'ADVISORY_BRIEF_BINDING_CHANGED'); currentSources(r.payload.sourceReferences, nowISO); });
    const kinds = ['SITUATION', 'PROBLEM', 'IMPLICATION', 'NEED_PAYOFF'] as const, prompts = { SITUATION: 'Welche aktuelle Website- oder Buchungssituation sollen wir gemeinsam prüfen?', PROBLEM: 'Was erschwert Ihren Kunden oder Ihrem Team heute den Ablauf?', IMPLICATION: 'Welche belegbaren Folgen hat dieses Problem, und wie häufig tritt es auf?', NEED_PAYOFF: 'Welche konkrete Verbesserung wäre für Sie wertvoll, und woran möchten Sie sie erkennen?' };
    const hasSituation = body.goals.length > 0 && body.audience.length > 0 && body.services.length > 0;
    const missing = kinds.filter(kind => !(kind === 'SITUATION' && hasSituation) && !answers.some(a => a.payload.kind === kind));
    return outcome({ briefRef: brief.reference, answerRefs: answers.map(advisoryReference), missingKinds: missing, questions: missing.slice(0, 2).map(kind => ({ id: `SPIN_${kind}`, kind, text: kind === 'NEED_PAYOFF' && body.goals[0] ? `${prompts[kind]} Ihr dokumentiertes Ziel: ${body.goals[0]}` : prompts[kind] })), recordedNeeds: answers.filter(r => r.payload.kind === 'NEED_PAYOFF').map(r => ({ answerRef: advisoryReference(r), text: r.payload.answer })), humanConfirmationRequired: true as const });
  });
}
export function prepareAdvisoryBuyerPacket(input: { input: z.infer<typeof advisoryBuyerPacketInputSchema>; parents: AdvisoryCanonicalParent[]; facts: AdvisoryGroundedFact[] }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const p = advisoryBuyerPacketInputSchema.parse(input.input), brief = input.parents.find(r => r.kind === 'BRIEF' && sameRef(r.reference, p.briefRef)); requireRule(brief, 'ADVISORY_BRIEF_REQUIRED'); parent(brief, 'BRIEF', ctx, nowISO); currentSources(p.sourceReferences, nowISO);
    for (const ref of [...p.demoRefs, ...(p.closePlanRef ? [p.closePlanRef] : [])]) { const found = input.parents.find(r => sameRef(r.reference, ref)); requireRule(found && ['DEMO', 'CLOSE_PLAN'].includes(found.kind), 'ADVISORY_PACKET_PARENT_MISSING'); parent(found, found.kind, ctx, nowISO); }
    const grounded = facts(input.facts, ctx, nowISO); requireRule(p.options.flatMap(o => [...o.benefits, ...o.limits]).every(text => grounded.some(f => f.text === text && f.category !== 'INTERNAL_CUSTOMER_FACT' && (f.category !== 'APPROVED_REFERENCE' || f.approvalRef))), 'ADVISORY_PACKET_CLAIM_EVIDENCE_REQUIRED');
    requireRule(new Set(p.steps.map(s => s.id)).size === p.steps.length, 'ADVISORY_STEP_DUPLICATE'); p.steps.forEach(s => currentSources(s.sourceReferences, nowISO));
    return outcome({ ...p, summary: 'Entscheidungsgrundlage mit dokumentierten Optionen, Grenzen und vorgeschlagenen nächsten Schritten.', publication: 'DRAFT_REQUIRES_APPROVAL' as const });
  });
}
export function validateAdvisoryAdvice(input: { request: z.infer<typeof advisoryAdviceInputSchema>; facts: AdvisoryGroundedFact[]; candidate: z.infer<typeof advisoryAdviceDraftSchema> }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const request = advisoryAdviceInputSchema.parse(input.request), rows = facts(input.facts, ctx, nowISO), draft = advisoryAdviceDraftSchema.parse(input.candidate);
    requireRule(request.factRefs.every(ref => rows.some(f => sameRef(f.evidenceRef, ref))), 'ADVISORY_REQUEST_FACT_MISSING');
    requireRule(draft.claims.every(c => rows.some(f => f.id === c.factId && request.factRefs.some(r => sameRef(r, f.evidenceRef)) && f.text.includes(c.exactQuote))), 'ADVISORY_UNGROUNDED_CLAIM');
    return outcome({ ...draft, requestDigest: advisoryDigest(request), factDigest: advisoryDigest(rows), factRefs: request.factRefs, buyerQuestionId: request.buyerQuestionId ?? null, status: 'DRAFT_REQUIRES_REVIEW' as const });
  });
}
export function extractAdvisoryTranscriptAssertions(input: { transcript: AdvisoryRecord; candidates: z.infer<typeof advisoryAssertionSchema>[] }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => { const transcript = readRecord(input.transcript, 'TRANSCRIPT', advisoryTranscriptSchema, ctx, nowISO), t = transcript.payload; currentSources([t.permissionReference, ...t.sourceReferences], nowISO);
    requireRule(new Set(t.segments.map(s => s.id)).size === t.segments.length && t.segments.every((s, i) => i === 0 || s.startMs >= t.segments[i - 1]!.endMs), 'ADVISORY_TRANSCRIPT_SEGMENTS_INVALID');
    const assertions = z.array(advisoryAssertionSchema).max(30).parse(input.candidates); requireRule(new Set(assertions.map(a => a.id)).size === assertions.length, 'ADVISORY_ASSERTION_DUPLICATE');
    assertions.forEach(a => requireRule(a.exactQuotes.length === a.segmentIds.length && a.segmentIds.every((id, i) => t.segments.some(s => s.id === id && s.text.includes(a.exactQuotes[i]!))), 'ADVISORY_ASSERTION_QUOTE_NOT_FOUND'));
    return outcome({ transcriptRef: advisoryReference(transcript), assertions, humanReviewRequired: true as const, canonicalFactsChanged: false as const });
  });
}
/** Accepting a recorded assertion never constitutes a customer agreement or changes canonical facts. */
export function reviewAdvisoryTranscriptAssertions(input: { transcript: AdvisoryRecord; analysis: AdvisoryRecord; review: z.infer<typeof advisoryTranscriptReviewSchema> }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const t = readRecord(input.transcript, 'TRANSCRIPT', advisoryTranscriptSchema, ctx, nowISO), a = verifyAdvisoryRecord(input.analysis, ctx, nowISO), review = advisoryTranscriptReviewSchema.parse(input.review);
    const analysis = advisoryEvaluationSchema(advisoryTranscriptAssertionsValueSchema).parse(a.payload);
    requireRule(a.kind === 'TRANSCRIPT_ASSERTIONS' && analysis.status === 'READY' && analysis.value && sameRef(review.analysisRef, advisoryReference(a)) && sameRef(review.transcriptRef, advisoryReference(t)) && sameRef(analysis.value.transcriptRef, advisoryReference(t)), 'ADVISORY_TRANSCRIPT_REVIEW_BINDING_CHANGED');
    const current = extractAdvisoryTranscriptAssertions({ transcript: t, candidates: analysis.value.assertions }, ctx, nowISO); requireRule(current.status === 'READY', 'ADVISORY_TRANSCRIPT_REVIEW_SOURCE_CHANGED');
    requireRule(new Set(review.decisions.map(d => d.assertionId)).size === review.decisions.length && review.decisions.every(d => analysis.value!.assertions.some(a => a.id === d.assertionId)), 'ADVISORY_REVIEW_ASSERTION_MISSING');
    return outcome({ review, acceptedAssertionIds: review.decisions.filter(d => d.decision === 'ACCEPTED_AS_RECORDED').map(d => d.assertionId), canonicalFactsChanged: false as const });
  });
}
function approvedKnowledge(raw: AdvisoryRecord, approvalRaw: AdvisoryRecord, ctx: AdvisoryContext, now: string) { const k = readRecord(raw, 'KNOWLEDGE', advisoryKnowledgeSchema, ctx, now), a = verifyAdvisoryRecord(approvalRaw, ctx, now), approval = advisoryApprovalInputSchema.parse(a.payload); requireRule(a.kind === 'KNOWLEDGE_APPROVAL' && sameRef(approval.recordRef, advisoryReference(k)) && Date.parse(approval.validUntil) > Date.parse(now), 'ADVISORY_KNOWLEDGE_APPROVAL_REQUIRED'); currentSources([k.payload.rightsReference, ...k.payload.sourceReferences], now); requireRule(!k.payload.sourceReferences.some(s => s.basis === 'PUBLIC_OBSERVATION') || k.payload.allowedUse === 'PUBLIC_SUMMARY', 'ADVISORY_PUBLIC_KNOWLEDGE_SUMMARY_ONLY'); return k; }
export function assessAdvisoryCoaching(input: { transcript: AdvisoryRecord; knowledge: AdvisoryRecord; approval: AdvisoryRecord }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => { const t = readRecord(input.transcript, 'TRANSCRIPT', advisoryTranscriptSchema, ctx, nowISO), k = approvedKnowledge(input.knowledge, input.approval, ctx, nowISO); currentSources([t.payload.permissionReference, ...t.payload.sourceReferences], nowISO); requireRule(k.payload.criteria.length > 0, 'ADVISORY_RUBRIC_REQUIRED');
    return outcome({ transcriptRef: advisoryReference(t), knowledgeRef: advisoryReference(k), findings: k.payload.criteria.map(c => { const observed = t.payload.segments.filter(s => s.speaker === 'SELLER' && c.evidenceTerms.some(term => s.text.toLowerCase().includes(term.toLowerCase()))); return { criterionId: c.id, label: c.label, status: observed.length ? 'POSSIBLE_EVIDENCE' as const : 'NOT_OBSERVED' as const, evidence: observed.slice(0, 3).map(s => ({ segmentId: s.id, exactQuote: s.text })) }; }), humanReviewRequired: true as const, performanceScore: null });
  });
}
export function prepareAdvisoryRoleplay(input: { knowledge: AdvisoryRecord; approval: AdvisoryRecord; scenarioId: string }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => { const k = approvedKnowledge(input.knowledge, input.approval, ctx, nowISO), scenario = k.payload.scenarios.find(s => s.id === input.scenarioId); requireRule(scenario, 'ADVISORY_ROLEPLAY_SCENARIO_REQUIRED'); return outcome({ knowledgeRef: advisoryReference(k), scenarioId: scenario.id, situation: scenario.situation, customerOpening: scenario.customerOpening, rubric: k.payload.criteria.map(c => ({ id: c.id, label: c.label })), simulationOnly: true as const, customerContactAllowed: false as const }); });
}
export function prepareAdvisoryVideoStoryboard(input: { input: z.infer<typeof advisoryVideoInputSchema>; demo: AdvisoryCanonicalParent; packet: AdvisoryRecord | null; assets: AdvisoryCanonicalParent[]; facts: AdvisoryGroundedFact[] }, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => { const p = advisoryVideoInputSchema.parse(input.input), demo = parent(input.demo, 'DEMO', ctx, nowISO); requireRule(sameRef(demo.reference, p.demoRef), 'ADVISORY_VIDEO_DEMO_BINDING_CHANGED'); const rows = facts(input.facts, ctx, nowISO).filter(f => f.category !== 'INTERNAL_CUSTOMER_FACT' && (f.category !== 'APPROVED_REFERENCE' || f.approvalRef)); requireRule(rows.length > 0, 'ADVISORY_VIDEO_APPROVED_FACT_REQUIRED');
    if (p.packetRef) { requireRule(input.packet, 'ADVISORY_VIDEO_PACKET_REQUIRED'); const packet = verifyAdvisoryRecord(input.packet, ctx, nowISO); requireRule(packet.kind === 'BUYER_PACKET' && sameRef(advisoryReference(packet), p.packetRef), 'ADVISORY_VIDEO_PACKET_BINDING_CHANGED'); }
    for (const ref of p.assetRefs) { const asset = input.assets.find(a => sameRef(a.reference, ref)); requireRule(asset, 'ADVISORY_VIDEO_ASSET_REQUIRED'); const a = parent(asset, 'ASSET', ctx, nowISO), data = z.object({ rightsReference: z.string().trim().min(1).max(500), sha256: z.hash('sha256'), revokedAt: z.string().nullable().optional() }).parse(a.data); requireRule(!data.revokedAt, 'ADVISORY_VIDEO_ASSET_RIGHTS_REQUIRED'); }
    const selected: typeof rows = []; let captionLength = 0; for (const row of rows) { if (selected.length < 3 && captionLength + row.text.length + (selected.length ? 1 : 0) <= 2000) { selected.push(row); captionLength += row.text.length + (selected.length > 1 ? 1 : 0); } }
    requireRule(selected.length > 0, 'ADVISORY_VIDEO_CAPTION_LIMIT'); const seconds = Math.floor(p.maximumSeconds / selected.length); return outcome({ title: p.title, language: p.language, demoRef: p.demoRef, packetRef: p.packetRef, assetRefs: p.assetRefs, maximumSeconds: p.maximumSeconds,
      shots: selected.map((fact, i) => ({ index: i, durationSeconds: i === selected.length - 1 ? p.maximumSeconds - seconds * i : seconds, narration: fact.text, factId: fact.id, evidenceRef: fact.evidenceRef, visual: 'PROTECTED_DEMO_CAPTURE' as const, demoRef: p.demoRef })), sourceBindingDigest: advisoryDigest({ demo: demo.reference, evidence: selected.map(f => f.evidenceRef), assets: p.assetRefs, packet: p.packetRef }), status: 'STORYBOARD_REQUIRES_APPROVAL' as const, customerSecretsIncluded: false as const, renderedVideo: false as const });
  });
}

import { advisoryExperimentPlanSchema as statsPlanSchema, advisoryForecastPolicySchema as statsPolicySchema, advisoryObservationSchema as statsObservationSchema } from './website-sales-advisory-types';

type StatsMember = ReturnType<typeof statsPlanSchema.parse>['cohort'][number];
type StatsObservation = ReturnType<typeof statsObservationSchema.parse>;
type StatsAssignment = { planRef: AdvisoryReference; unitKey: string; arm: 'CONTROL' | 'VARIANT'; treatmentRef: AdvisoryReference; assignedAt: string; eligibilityDigest: string; assignmentSaltDigest: string; cohortSourceDigest: string };
function statsResult<T>(status: AdvisoryEvaluation<T>['status'], value: T | null, reasons: string[] = []): AdvisoryEvaluation<T> { return { status, value, reasons, externalEffectAllowed: false, requiresServerAuthorization: true }; }
function statsRequire(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
function statsUnit(identity: AdvisoryIdentity) { return `${identity.workspaceId}:${identity.companyId}`; }
function statsTime(value: string) { const n = Date.parse(value); statsRequire(Number.isFinite(n), 'ADVISORY_STATISTICS_TIME_INVALID'); return n; }
function statsFailure(error: unknown) { return error instanceof Error && /^ADVISORY_[A-Z_]+$/.test(error.message) ? error.message : 'ADVISORY_STATISTICS_INVALID'; }
function statsCohort(cohort: StatsMember[], ctx: AdvisoryContext) {
  statsRequire(cohort.every(m => m.identity.workspaceId === ctx.identity.workspaceId && m.identity.projectId === ctx.identity.projectId) && new Set(cohort.map(m => statsUnit(m.identity))).size === cohort.length, 'ADVISORY_COHORT_COMPANY_DUPLICATE_OR_FOREIGN');
  const allowed = [{ identity: ctx.identity, workflowId: ctx.workflowId, workflowVersion: ctx.workflowVersion }, ...(ctx.authorizedResources ?? [])];
  statsRequire(cohort.every(m => allowed.some(a => advisoryDigest(a.identity) === advisoryDigest(m.identity) && a.workflowId === m.workflowId && a.workflowVersion >= m.workflowVersion)), 'ADVISORY_COHORT_RESOURCE_AUTHORITY_REQUIRED');
}
function statsMemberMatch(member: StatsMember, observation: StatsObservation, assignedAt: string) {
  return advisoryDigest(member.identity) === advisoryDigest(observation.identity) && member.workflowId === observation.workflowId && statsTime(assignedAt) === statsTime(observation.assignedAt) && member.sourceDigest === observation.cohortSourceDigest;
}
function statsReadPlan(raw: AdvisoryRecord, ctx: AdvisoryContext, nowISO: string) {
  const row = verifyAdvisoryPeerRecord(raw, ctx, nowISO), plan = statsPlanSchema.parse(row.payload);
  statsRequire(row.kind === 'EXPERIMENT_PLAN' && statsTime(plan.registeredAt) <= statsTime(row.createdAt) && statsTime(plan.enrollmentEndsAt) > statsTime(row.createdAt), 'ADVISORY_EXPERIMENT_PREREGISTRATION_REQUIRED');
  statsCohort(plan.cohort, ctx); return { row, plan };
}
function statsAssignments(rows: readonly AdvisoryRecord[], planRow: AdvisoryRecord, plan: ReturnType<typeof statsPlanSchema.parse>, ctx: AdvisoryContext, nowISO: string) {
  statsRequire(rows.length <= 50, 'ADVISORY_STATISTICS_LIMIT');
  const units = new Set<string>();
  return rows.map(raw => {
    const member = plan.cohort.find(m => advisoryDigest(m.identity) === advisoryDigest(raw.identity) && m.workflowId === raw.workflowId);
    statsRequire(member, 'ADVISORY_ASSIGNMENT_OUTSIDE_COHORT');
    const row = verifyAdvisoryPeerRecord(raw, ctx, nowISO);
    statsRequire(row.payload.status === 'READY' && row.payload.externalEffectAllowed === false && row.payload.requiresServerAuthorization === true && row.payload.value && typeof row.payload.value === 'object', 'ADVISORY_ASSIGNMENT_EVALUATION_REQUIRED');
    const p = row.payload.value as StatsAssignment;
    statsRequire(row.kind === 'EXPERIMENT_ASSIGNMENT' && advisoryDigest(p.planRef) === advisoryDigest(advisoryReference(planRow)) && p.unitKey === statsUnit(member.identity) && !units.has(p.unitKey), 'ADVISORY_ORIGINAL_ASSIGNMENT_REQUIRED');
    statsRequire((p.arm === 'CONTROL' || p.arm === 'VARIANT') && advisoryDigest(p.treatmentRef) === advisoryDigest(p.arm === 'CONTROL' ? plan.controlRef : plan.variantRef) && p.eligibilityDigest === plan.eligibilityDigest && p.assignmentSaltDigest === plan.assignmentSaltDigest && p.cohortSourceDigest === member.sourceDigest, 'ADVISORY_ASSIGNMENT_PLAN_MISMATCH');
    statsRequire(statsTime(p.assignedAt) >= Math.max(statsTime(plan.registeredAt), statsTime(planRow.createdAt), statsTime(member.assignedAt)) && statsTime(p.assignedAt) <= Math.min(statsTime(plan.enrollmentEndsAt), statsTime(row.createdAt)), 'ADVISORY_PROSPECTIVE_ASSIGNMENT_REQUIRED');
    units.add(p.unitKey); return { row, member, assignment: p };
  });
}
function statsWilson(wins: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.959963984540054, z2 = z * z, p = wins / n, denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator, radius = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
function statsLabel(o: StatsObservation, horizonDays: number, cutoff: number): 0 | 1 | null {
  const anchor = statsTime(o.assignedAt), end = anchor + horizonDays * 86400000;
  statsRequire(o.horizonDays === horizonDays && statsTime(o.availableAt) >= anchor, 'ADVISORY_OUTCOME_HORIZON_MISMATCH');
  if (o.outcome === 'WON') statsRequire(o.outcomeAt !== null && statsTime(o.outcomeAt) >= anchor && statsTime(o.availableAt) >= statsTime(o.outcomeAt), 'ADVISORY_OUTCOME_TIME_INVALID');
  if (o.outcome === 'NOT_WON') statsRequire(o.outcomeAt === null, 'ADVISORY_OUTCOME_TIME_INVALID');
  if (cutoff < end || statsTime(o.availableAt) > cutoff || o.coverage !== 'COMPLETE' || o.outcome === 'UNKNOWN' || o.outcome === 'PENDING' || o.outcome === 'NOT_WON' && statsTime(o.availableAt) < end) return null;
  return o.outcome === 'WON' && statsTime(o.outcomeAt!) <= end ? 1 : 0;
}
export function assignAdvisoryExperiment(input: { plan: AdvisoryRecord; seed: string; assignments?: AdvisoryRecord[]; stop?: AdvisoryRecord | null }, ctx: AdvisoryContext, nowISO: string) {
  try {
    const { row, plan } = statsReadPlan(input.plan, ctx, nowISO), assignments = statsAssignments(input.assignments ?? [], row, plan, ctx, nowISO), now = statsTime(nowISO);
    if (input.stop) { const stop = verifyAdvisoryPeerRecord(input.stop, ctx, nowISO); statsRequire(stop.kind === 'EXPERIMENT_STOP' && advisoryDigest(stop.payload.experimentRef) === advisoryDigest(advisoryReference(row)), 'ADVISORY_EXPERIMENT_STOP_MISMATCH'); statsRequire(false, 'ADVISORY_EXPERIMENT_STOPPED'); }
    statsRequire(advisoryContentSha256(input.seed) === plan.assignmentSaltDigest && input.seed.length >= 16 && input.seed.length <= 1000, 'ADVISORY_ASSIGNMENT_SEED_REQUIRED');
    statsRequire(now >= statsTime(row.createdAt) && now <= statsTime(plan.enrollmentEndsAt) && assignments.length < plan.maximumCompanies, 'ADVISORY_EXPERIMENT_ENROLLMENT_CLOSED');
    const member = plan.cohort.find(m => advisoryDigest(m.identity) === advisoryDigest(ctx.identity) && m.workflowId === ctx.workflowId);
    statsRequire(member && statsTime(member.assignedAt) <= now && member.workflowVersion <= ctx.workflowVersion, 'ADVISORY_ASSIGNMENT_OUTSIDE_COHORT');
    const unitKey = statsUnit(ctx.identity); statsRequire(!assignments.some(a => a.assignment.unitKey === unitKey), 'ADVISORY_EXPERIMENT_ALREADY_ASSIGNED');
    const planRef = advisoryReference(row), arm = parseInt(advisoryContentSha256(JSON.stringify([planRef, unitKey, input.seed])).slice(-1), 16) % 2 ? 'VARIANT' as const : 'CONTROL' as const;
    const value: StatsAssignment = { planRef, unitKey, arm, treatmentRef: arm === 'CONTROL' ? plan.controlRef : plan.variantRef, assignedAt: nowISO, eligibilityDigest: plan.eligibilityDigest, assignmentSaltDigest: plan.assignmentSaltDigest, cohortSourceDigest: member.sourceDigest };
    return statsResult('READY', value);
  } catch (error) { return statsResult<StatsAssignment>('BLOCKED', null, [statsFailure(error)]); }
}
export function evaluateAdvisoryExperiment(input: { plan: AdvisoryRecord; assignments: AdvisoryRecord[]; observations: unknown[]; stop?: AdvisoryRecord | null }, ctx: AdvisoryContext, nowISO: string) {
  try {
    const { row, plan } = statsReadPlan(input.plan, ctx, nowISO), assignments = statsAssignments(input.assignments, row, plan, ctx, nowISO), now = statsTime(nowISO);
    statsRequire(assignments.length <= plan.maximumCompanies && input.observations.length === assignments.length, 'ADVISORY_ORIGINAL_ITT_COHORT_REQUIRED');
    const observations = input.observations.map(o => statsObservationSchema.parse(o));
    statsRequire(new Set(observations.map(o => statsUnit(o.identity))).size === observations.length, 'ADVISORY_OUTCOME_DUPLICATE');
    let stopped = false;
    if (input.stop) { const stop = verifyAdvisoryPeerRecord(input.stop, ctx, nowISO); statsRequire(stop.kind === 'EXPERIMENT_STOP' && advisoryDigest(stop.payload.experimentRef) === advisoryDigest(advisoryReference(row)), 'ADVISORY_EXPERIMENT_STOP_MISMATCH'); stopped = true; }
    const arms = (['CONTROL', 'VARIANT'] as const).map(arm => {
      const selected = assignments.filter(a => a.assignment.arm === arm); let wins = 0, known = 0, pending = 0;
      for (const a of selected) {
        const o = observations.find(o => statsMemberMatch(a.member, o, a.assignment.assignedAt));
        statsRequire(o && o.treatmentDigest === a.assignment.treatmentRef.digest, 'ADVISORY_ORIGINAL_ITT_COHORT_REQUIRED');
        const label = statsLabel(o, plan.horizonDays, now); if (label !== null) { known++; wins += label; }
        else if (statsTime(a.assignment.assignedAt) + plan.horizonDays * 86400000 > now) pending++;
      }
      const assigned = selected.length, unknown = assigned - known;
      return { arm, assigned, wins, known, pending, unknown, rate: unknown || !assigned ? null : wins / assigned, bounds: assigned ? [wins / assigned, (wins + unknown) / assigned] : [0, 1], wilson95: unknown ? null : statsWilson(wins, assigned) };
    });
    const control = arms[0]!, variant = arms[1]!, closed = stopped || now >= statsTime(plan.enrollmentEndsAt) || assignments.length >= plan.maximumCompanies;
    const sufficient = closed && !stopped && arms.every(a => a.assigned >= plan.minimumPerArm && a.pending === 0 && a.unknown * 10000 <= a.assigned * plan.maximumUnknownBps);
    const effectBounds = [variant.bounds[0]! - control.bounds[1]!, variant.bounds[1]! - control.bounds[0]!];
    let difference95: [number, number] | null = null;
    if (control.rate !== null && variant.rate !== null && control.wilson95 && variant.wilson95) {
      const d = variant.rate - control.rate;
      difference95 = [d - Math.hypot(variant.rate - variant.wilson95[0], control.wilson95[1] - control.rate), d + Math.hypot(variant.wilson95[1] - variant.rate, control.rate - control.wilson95[0])];
    }
    const value = { planRef: advisoryReference(row), unit: 'WORKSPACE_COMPANY' as const, analysis: 'INTENTION_TO_TREAT' as const, horizonDays: plan.horizonDays, enrollmentClosed: closed, stopped, arms, effectBounds, difference95, promotion: 'REVIEW_REQUIRED' as const, automaticallyPromoted: false as const };
    return statsResult(sufficient ? 'READY' : 'INSUFFICIENT_DATA', value, sufficient ? [] : [stopped ? 'ADVISORY_EXPERIMENT_STOPPED' : 'ADVISORY_EXPERIMENT_DATA_INCOMPLETE']);
  } catch (error) { return statsResult<never>('BLOCKED', null, [statsFailure(error)]); }
}
export function forecastAdvisoryCohort(input: { policy: AdvisoryRecord; observations: unknown[] }, ctx: AdvisoryContext, nowISO: string) {
  try {
    const row = verifyAdvisoryPeerRecord(input.policy, ctx, nowISO), policy = statsPolicySchema.parse(row.payload), now = statsTime(nowISO), cut = statsTime(policy.trainEndsAt), start = statsTime(policy.holdoutStartsAt), end = statsTime(policy.holdoutEndsAt);
    statsRequire(row.kind === 'FORECAST_POLICY' && cut < start && start <= end && end <= now && (policy.validationMode === 'RETROSPECTIVE_TIME_HOLDOUT' || statsTime(row.createdAt) <= start) && statsTime(policy.validUntil) > now, 'ADVISORY_FORECAST_SPLIT_INVALID');
    statsCohort(policy.cohort, ctx); statsRequire(input.observations.length === policy.cohort.length, 'ADVISORY_FORECAST_EXACT_COHORT_REQUIRED');
    const observations = input.observations.map(o => statsObservationSchema.parse(o));
    statsRequire(new Set(observations.map(o => statsUnit(o.identity))).size === observations.length, 'ADVISORY_OUTCOME_DUPLICATE');
    const training: number[] = [], holdout: number[] = []; let pending = 0, unknown = 0, outsideWindow = 0;
    for (const member of policy.cohort) {
      const o = observations.find(o => statsMemberMatch(member, o, member.assignedAt));
      statsRequire(o && o.segmentKey === policy.segmentKey && o.treatmentDigest === policy.treatmentDigest, 'ADVISORY_FORECAST_EXACT_COHORT_REQUIRED');
      const anchor = statsTime(o.assignedAt), trainingWindow = anchor <= cut, holdoutWindow = anchor >= start && anchor <= end;
      statsRequire(anchor <= now, 'ADVISORY_FORECAST_FUTURE_COHORT');
      if (!trainingWindow && !holdoutWindow) { outsideWindow++; continue; }
      const cutoff = trainingWindow ? cut : now, label = statsLabel(o, policy.horizonDays, cutoff);
      if (label === null) { if (anchor + policy.horizonDays * 86400000 > cutoff) pending++; else unknown++; }
      else (trainingWindow ? training : holdout).push(label);
    }
    const wins = training.reduce((s, y) => s + y, 0), n = training.length, p = n ? wins / n : null, interval95 = n ? statsWilson(wins, n) : null, holdoutWins = holdout.reduce((s, y) => s + y, 0);
    const brier = p === null || !holdout.length ? null : holdout.reduce((s, y) => s + (p - y) ** 2, 0) / holdout.length;
    const enough = pending === 0 && unknown === 0 && outsideWindow === 0 && n >= policy.minimumTrain && holdout.length >= policy.minimumHoldout && wins >= policy.minimumClassCount && n - wins >= policy.minimumClassCount && holdoutWins >= policy.minimumClassCount && holdout.length - holdoutWins >= policy.minimumClassCount && interval95 !== null && (interval95[1] - interval95[0]) * 10000 <= policy.maximumIntervalWidthBps && brier !== null && brier * 10000 <= policy.maximumBrierBps;
    const value = { policyRef: advisoryReference(row), validationMode: policy.validationMode, postHocPolicySelection: policy.validationMode === 'RETROSPECTIVE_TIME_HOLDOUT', prospectiveValidation: false as const, basis: enough ? 'EMPIRICAL' as const : 'INSUFFICIENT_DATA' as const, probability: enough ? p : null, interval95: enough ? interval95 : null, horizonDays: policy.horizonDays, training: { n, wins }, holdout: { n: holdout.length, wins: holdoutWins, brier, baselineBrier: brier, calibration: p !== null && holdout.length ? [{ n: holdout.length, meanPrediction: p, observedRate: holdoutWins / holdout.length, observedWilson95: statsWilson(holdoutWins, holdout.length) }] : [] }, excluded: { pending, unknown, outsideWindow }, dataDigest: advisoryDigest([...observations].sort((a, b) => statsUnit(a.identity).localeCompare(statsUnit(b.identity)))), promotion: 'REVIEW_REQUIRED' as const };
    return statsResult(enough ? 'READY' : 'INSUFFICIENT_DATA', value, enough ? [] : ['ADVISORY_FORECAST_INSUFFICIENT_CLOSED_DATA']);
  } catch (error) { return statsResult<never>('BLOCKED', null, [statsFailure(error)]); }
}

import { advisoryBuyerPacketValueSchema as buyerPacketValueSchema, advisoryBuyerValueCaseSchema as buyerPublicValueCaseSchema, advisoryValueCaseValueSchema as buyerStoredValueCaseSchema } from './website-sales-advisory-types';

const buyerPacketEvaluationSchema = z.strictObject({ status: z.literal('READY'), value: buyerPacketValueSchema, reasons: z.array(z.string()).max(0), externalEffectAllowed: z.literal(false), requiresServerAuthorization: z.literal(true) });
const buyerStoredValueEvaluationSchema = z.strictObject({ status: z.literal('READY'), value: buyerStoredValueCaseSchema, reasons: z.array(z.string()).max(0), externalEffectAllowed: z.literal(false), requiresServerAuthorization: z.literal(true) });
type BuyerProjectionInput = { packet: AdvisoryRecord; approval: AdvisoryRecord; valueCase?: AdvisoryRecord | null; basis?: AdvisoryRecord | null; offer?: AdvisoryCanonicalParent | null };
function buyerPublicValue(input: BuyerProjectionInput, packetValue: z.infer<typeof buyerPacketValueSchema>, ctx: AdvisoryContext, nowISO: string): z.infer<typeof buyerPublicValueCaseSchema> | null {
  try {
    if (!packetValue.valueCaseRef || !input.valueCase || !input.basis || !input.offer) return null;
    const row = verifyAdvisoryRecord(input.valueCase, ctx, nowISO), body = buyerStoredValueEvaluationSchema.parse(row.payload).value;
    const basis = readRecord(input.basis, 'VALUE_BASIS', advisoryValueBasisSchema, ctx, nowISO), offer = parent(input.offer, 'OFFER', ctx, nowISO);
    requireRule(row.kind === 'VALUE_CASE' && sameRef(packetValue.valueCaseRef, advisoryReference(row)) && sameRef(body.basisRef, advisoryReference(basis)) && sameRef(basis.payload.offerRef, offer.reference), 'ADVISORY_BUYER_VALUE_BINDING_REQUIRED');
    z.object({ status: z.enum(['APPROVED', 'SENT', 'ACCEPTED']), approvalReference: z.uuid() }).parse(offer.data);
    const calculated = calculateAdvisoryValueCase(basis, ctx, nowISO);
    requireRule(calculated.status === 'READY' && calculated.value !== null && advisoryDigest(calculated.value) === advisoryDigest(body), 'ADVISORY_BUYER_VALUE_CHANGED');
    return buyerPublicValueCaseSchema.parse({ currency: body.currency, amountBasis: body.amountBasis, scenarioOnly: body.scenarioOnly, roiGuaranteed: body.roiGuaranteed, approvedOfferRef: offer.reference, horizonMonths: basis.payload.horizonMonths,
      scenarios: body.scenarios.map(s => ({ name: s.name, totalCostMinor: s.totalCostMinor, totalCashBenefitMinor: s.totalCashBenefitMinor, netCashMinor: s.netCashMinor, roiBps: s.roiBps, paybackMonth: s.paybackMonth })) });
  } catch { return null; }
}
/** Content projection only: the server supplies actual grant, identity and step state. */
export function projectAdvisoryBuyerPacket(input: BuyerProjectionInput, ctx: AdvisoryContext, nowISO: string) {
  return guarded(() => {
    const packet = verifyAdvisoryRecord(input.packet, ctx, nowISO), approval = verifyAdvisoryRecord(input.approval, ctx, nowISO);
    requireRule(packet.kind === 'BUYER_PACKET' && approval.kind === 'BUYER_PACKET_APPROVAL', 'ADVISORY_BUYER_PACKET_APPROVAL_REQUIRED');
    const body = buyerPacketEvaluationSchema.parse(packet.payload).value, permission = advisoryApprovalInputSchema.parse(approval.payload), now = Date.parse(nowISO);
    requireRule(sameRef(permission.recordRef, advisoryReference(packet)) && Date.parse(permission.validUntil) > now && Date.parse(body.validUntil) > now && Date.parse(approval.createdAt) >= Date.parse(packet.createdAt), 'ADVISORY_BUYER_PACKET_APPROVAL_REQUIRED');
    currentSources(body.sourceReferences, nowISO); body.steps.forEach(step => currentSources(step.sourceReferences, nowISO));
    requireRule(new Set(body.steps.map(step => step.id)).size === body.steps.length, 'ADVISORY_STEP_DUPLICATE');
    return outcome({ packetRef: advisoryReference(packet), title: body.title, summary: body.summary, decisionCriteria: [...body.decisionCriteria],
      options: body.options.map(option => ({ label: option.label, benefits: [...option.benefits], limits: [...option.limits] })),
      steps: body.steps.map(step => ({ id: step.id, version: 1 as const, label: step.label, responsible: step.responsible, dueAt: step.dueAt, status: 'PROPOSED' as const })), valueCase: buyerPublicValue(input, body, ctx, nowISO) });
  });
}
