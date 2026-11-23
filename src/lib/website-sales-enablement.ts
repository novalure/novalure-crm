import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CANONICAL_WEBSITE_SALES_CATALOG, canonicalEnablementContactSchema, canonicalEnablementRecordSchema,
  canonicalEnablementTaskSchema, canonicalEnablementWorkflowSchema, careBasisSchema, carePlanKeySchema, closePlanSchema,
  closureReasonSchema, customerBriefSchema, demoProfileSchema, enablementAssetMetadataSchema,
  enablementIdentitySchema, enablementScopeSchema, enablementSourceReferenceSchema, enablementText, enablementTime,
  enablementUuid, industryCodeSchema, referenceCaseSchema, referenceReviewSchema, websiteSalesCareProposalSchema,
  type CanonicalEnablementRecord, type EnablementEvaluation, type EnablementIdentity, type EnablementSourceReference,
  type WebsiteCareProposal, type WebsiteDailyPriority, type WebsiteHygieneCandidate,
} from './website-sales-enablement-types';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function websiteSalesEnablementDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Revocation is fresh lifecycle state, deliberately excluded from the immutable body digest. */
export function websiteSalesEnablementRecordDigest(record: Omit<CanonicalEnablementRecord<unknown>, 'digest'> | CanonicalEnablementRecord<unknown>): string {
  const { id, identity, version, workflowVersion, recordedBy, createdAt, validUntil, payload } = record;
  return websiteSalesEnablementDigest({ id, identity, version, workflowVersion, recordedBy, createdAt, validUntil, payload });
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function result<T>(value: T | null, reasons: string[], status: EnablementEvaluation<T>['status'] = reasons.length ? 'NEEDS_CLARIFICATION' : 'READY'): EnablementEvaluation<T> {
  const body = { status, reasons: [...new Set(reasons)], value, externalEffectAllowed: false as const, requiresServerAuthorization: true as const };
  return freeze({ ...body, digest: websiteSalesEnablementDigest(body) });
}
function fail(code: string): never { throw new Error(code); }
function equal(a: EnablementIdentity, b: EnablementIdentity): boolean { return websiteSalesEnablementDigest(a) === websiteSalesEnablementDigest(b); }
function current(from: string, until: string, now: string): boolean { return Date.parse(from) <= Date.parse(now) && Date.parse(now) < Date.parse(until); }
function sourceReasons(sources: EnablementSourceReference[], now: string): string[] {
  const parsed = z.array(enablementSourceReferenceSchema).min(1).max(100).parse(sources);
  return [...(new Set(parsed.map(source => source.reference)).size !== parsed.length ? ['DUPLICATE_SOURCE_REFERENCE'] : []),
    ...(parsed.some(source => !current(source.observedAt, source.validUntil, now)) ? ['CURRENT_SOURCE_REQUIRED'] : [])];
}
export const websiteSalesEnablementContextSchema = z.strictObject({ identity: enablementIdentitySchema,
  workflowVersion: z.number().int().positive().safe(), workflow: canonicalEnablementWorkflowSchema,
  contacts: z.array(canonicalEnablementContactSchema).max(500), tasks: z.array(canonicalEnablementTaskSchema).max(500) });
export type WebsiteSalesEnablementContext = z.infer<typeof websiteSalesEnablementContextSchema>;
function context(raw: unknown, now: string): WebsiteSalesEnablementContext {
  enablementTime.parse(now); const ctx = websiteSalesEnablementContextSchema.parse(raw);
  if (!equal(ctx.identity, ctx.workflow.identity) || ctx.workflowVersion !== ctx.workflow.version || Date.parse(ctx.workflow.observedAt) > Date.parse(now)) fail('ENABLEMENT_CURRENT_WORKFLOW_REQUIRED');
  if (ctx.contacts.some(row => !equal(row.identity, ctx.identity)) || ctx.tasks.some(row => !equal(row.identity, ctx.identity))) fail('ENABLEMENT_FOREIGN_CANONICAL_SCOPE');
  if (new Set(ctx.contacts.map(row => row.contactId)).size !== ctx.contacts.length || new Set(ctx.tasks.map(row => row.taskId)).size !== ctx.tasks.length) fail('ENABLEMENT_DUPLICATE_CANONICAL_RECORD');
  if (ctx.tasks.some(row => Date.parse(row.observedAt) > Date.parse(now))) fail('ENABLEMENT_FUTURE_CANONICAL_TASK');
  return ctx;
}
export function verifyWebsiteSalesEnablementRecord<T extends z.ZodType>(raw: unknown, payloadSchema: T, rawContext: unknown, now: string) {
  const ctx = context(rawContext, now), record = canonicalEnablementRecordSchema(payloadSchema).parse(raw) as CanonicalEnablementRecord<z.output<T>>;
  if (!equal(record.identity, ctx.identity)) fail('ENABLEMENT_FOREIGN_RECORD');
  if (record.digest !== websiteSalesEnablementRecordDigest(record)) fail('ENABLEMENT_RECORD_DIGEST_CHANGED');
  if (record.workflowVersion > ctx.workflowVersion || record.revokedAt !== null || !current(record.createdAt, record.validUntil, now)) fail('ENABLEMENT_RECORD_NOT_CURRENT');
  return record;
}

export function assessWebsiteSalesCustomerBrief(raw: unknown, rawContext: unknown, now: string) {
  context(rawContext, now); const brief = customerBriefSchema.parse(raw), reasons = sourceReasons(brief.sourceReferences, now);
  if (Date.parse(brief.validUntil) <= Date.parse(now) || reasons.length) return result(null, [...reasons, 'CURRENT_BRIEF_REQUIRED'], 'BLOCKED');
  if (!brief.goals.length) reasons.push('CUSTOMER_GOALS_UNKNOWN');
  if (!brief.audience.length) reasons.push('CUSTOMER_AUDIENCE_UNKNOWN');
  if (!brief.services.length) reasons.push('CUSTOMER_SERVICE_SCOPE_UNKNOWN');
  if (brief.customerBudget.status === 'UNKNOWN') reasons.push('CUSTOMER_BUDGET_UNKNOWN');
  else if (brief.customerBudget.amountMinor === 0) reasons.push('CUSTOMER_BUDGET_KNOWN_ZERO');
  if (brief.timeframe.status === 'UNKNOWN') reasons.push('CUSTOMER_TIMEFRAME_UNKNOWN');
  else if (Date.parse(brief.timeframe.targetDate!) <= Date.parse(now)) reasons.push('CUSTOMER_TIMEFRAME_NEEDS_RECONFIRMATION');
  if (brief.openQuestions.length) reasons.push('OPEN_CUSTOMER_QUESTIONS');
  const questions = [!brief.goals.length ? 'Welches konkrete Ziel soll die Website erfüllen?' : null,
    !brief.audience.length ? 'Für welche Zielgruppe wird die Website benötigt?' : null,
    !brief.services.length ? 'Welche Leistungen werden für die Website gewünscht?' : null,
    brief.customerBudget.status === 'UNKNOWN' ? 'Welcher kundenseitige Budgetrahmen ist bekannt?' : null,
    brief.customerBudget.status === 'KNOWN' && brief.customerBudget.amountMinor === 0 ? 'Ist der dokumentierte Budgetrahmen von 0 Euro weiterhin aktuell?' : null,
    brief.timeframe.status === 'UNKNOWN' ? 'Welcher Zeitrahmen ist bekannt?' : null,
    brief.timeframe.status === 'KNOWN' && Date.parse(brief.timeframe.targetDate!) <= Date.parse(now) ? 'Welcher neue Wunschtermin soll bestätigt werden?' : null,
    ...brief.openQuestions].filter((value): value is string => value !== null);
  return result({ brief, questions, budgetUse: 'CUSTOMER_REPORTED_NOT_INTERNAL_SPENDING_AUTHORITY' as const }, reasons);
}

export function assessWebsiteSalesClosePlan(raw: unknown, rawContext: unknown, now: string) {
  const ctx = context(rawContext, now), plan = closePlanSchema.parse(raw), reasons = sourceReasons(plan.sourceReferences, now);
  if (Date.parse(plan.validUntil) <= Date.parse(now)) reasons.push('CLOSE_PLAN_EXPIRED');
  if (new Set(plan.contacts.map(row => row.contactId)).size !== plan.contacts.length || new Set(plan.milestones.map(row => row.taskId)).size !== plan.milestones.length) fail('ENABLEMENT_DUPLICATE_CLOSE_PLAN_REFERENCE');
  let blocked = reasons.length > 0;
  for (const contact of plan.contacts) {
    const row = ctx.contacts.find(value => value.contactId === contact.contactId);
    reasons.push(...sourceReasons(contact.sourceReferences, now));
    if (!row?.active) { reasons.push('ACTIVE_CANONICAL_CONTACT_REQUIRED'); blocked = true; }
    else if (contact.contactVersion === undefined || contact.sourceDigest === undefined) reasons.push('CONTACT_VERSION_EVIDENCE_REQUIRED');
    else if (row.version !== contact.contactVersion || row.sourceDigest !== contact.sourceDigest) { reasons.push('CANONICAL_CONTACT_CHANGED'); blocked = true; }
    if (new Set(contact.roles).size !== contact.roles.length) fail('ENABLEMENT_DUPLICATE_CONTACT_ROLE');
  }
  if (!plan.contacts.some(row => row.roles.includes('DECISION_MAKER'))) reasons.push('DECISION_MAKER_NOT_RECORDED');
  if (!plan.contacts.some(row => row.roles.includes('SIGNATORY'))) reasons.push('SIGNATORY_NOT_RECORDED');
  const milestones = [];
  for (const milestone of plan.milestones) {
    const row = ctx.tasks.find(value => value.taskId === milestone.taskId);
    reasons.push(...sourceReasons(milestone.sourceReferences, now));
    if (!row || row.version !== milestone.taskVersion) { reasons.push('CANONICAL_MILESTONE_CHANGED'); blocked = true; continue; }
    if (milestone.kind === 'CUSTOMER_AGREEMENT_RECORDED' && !milestone.sourceReferences.some(source => source.basis === 'CUSTOMER_AGREEMENT_RECORDED')) {
      reasons.push('RECORDED_CUSTOMER_AGREEMENT_SOURCE_REQUIRED'); blocked = true;
    }
    milestones.push({ taskId: row.taskId, taskVersion: row.version, kind: milestone.kind, dueAt: row.dueAt, status: row.status });
  }
  const nextStep = ctx.tasks.find(row => row.taskId === plan.nextStepTaskId) ?? null;
  if (!nextStep) reasons.push('NEXT_STEP_CANONICAL_TASK_REQUIRED');
  else if (['DONE', 'CANCELLED'].includes(nextStep.status)) reasons.push('NEXT_STEP_ALREADY_TERMINAL');
  else if (nextStep.status === 'BLOCKED') reasons.push('NEXT_STEP_BLOCKED');
  if (nextStep && nextStep.dueAt === null) reasons.push('NEXT_STEP_DUE_DATE_UNKNOWN');
  if (reasons.some(reason => ['CURRENT_SOURCE_REQUIRED', 'DUPLICATE_SOURCE_REFERENCE'].includes(reason))) blocked = true;
  return result({ plan, milestones, nextStep, recordedContactRolesAreSigningAuthority: false as const, customerCommitmentCreated: false as const }, reasons, blocked ? 'BLOCKED' : reasons.length ? 'NEEDS_CLARIFICATION' : 'READY');
}

export function resolveWebsiteSalesDemoProfile(rawProfile: unknown, rawReferences: unknown, rawReviews: unknown, rawAssets: unknown, rawContext: unknown, now: string) {
  const ctx = context(rawContext, now), profile = verifyWebsiteSalesEnablementRecord(rawProfile, demoProfileSchema, ctx, now);
  const records = z.array(canonicalEnablementRecordSchema(referenceCaseSchema)).max(100).parse(rawReferences);
  const reviews = z.array(referenceReviewSchema).max(100).parse(rawReviews), assets = z.array(enablementAssetMetadataSchema).max(100).parse(rawAssets);
  if (new Set(records.map(row => row.id)).size !== records.length || new Set(assets.map(row => row.assetId)).size !== assets.length) fail('ENABLEMENT_LATEST_REFERENCE_SNAPSHOT_REQUIRED');
  const reasons = sourceReasons(profile.payload.sourceReferences, now), selectedReferences = [], selectedAssets = [];
  if (Date.parse(profile.payload.validUntil) <= Date.parse(now)) reasons.push('DEMO_PROFILE_EXPIRED');
  if (new Set(profile.payload.referenceCaseIds).size !== profile.payload.referenceCaseIds.length || new Set(profile.payload.assetIds).size !== profile.payload.assetIds.length) fail('ENABLEMENT_DUPLICATE_PROFILE_REFERENCE');
  for (const id of profile.payload.referenceCaseIds) {
    const record = records.find(row => row.id === id);
    if (!record) { reasons.push('APPROVED_REFERENCE_REQUIRED'); continue; }
    verifyWebsiteSalesEnablementRecord(record, referenceCaseSchema, ctx, now);
    const review = reviews.find(row => row.referenceId === id && row.referenceVersion === record.version && row.referenceDigest === record.digest);
    if (!review || review.revokedAt !== null || !current(review.approvedAt, review.validUntil, now) || record.payload.disclosure !== 'APPROVED_CUSTOMER_PRESENTATION') { reasons.push('CURRENT_REFERENCE_PRESENTATION_APPROVAL_REQUIRED'); continue; }
    if (record.payload.industryCode !== 'GENERAL' && record.payload.industryCode !== profile.payload.industryCode) { reasons.push('REFERENCE_INDUSTRY_MISMATCH'); continue; }
    reasons.push(...sourceReasons(record.payload.sourceReferences, now));
    for (const claim of record.payload.claims) reasons.push(...sourceReasons(claim.sourceReferences, now));
    if (Date.parse(record.payload.validUntil) <= Date.parse(now)) reasons.push('REFERENCE_EXPIRED');
    selectedReferences.push({ record, review });
  }
  for (const id of profile.payload.assetIds) {
    const asset = assets.find(row => row.assetId === id);
    if (!asset || !equal(asset.identity, ctx.identity) || asset.revokedAt !== null || !current(asset.approvedAt, asset.validUntil, now)) { reasons.push('CURRENT_SCOPED_ASSET_RIGHTS_REQUIRED'); continue; }
    selectedAssets.push(asset);
  }
  if (new Set(selectedAssets.map(row => row.role)).size !== selectedAssets.length) reasons.push('DUPLICATE_ASSET_ROLE');
  return result(reasons.length ? null : { profile, references: selectedReferences, assets: selectedAssets }, reasons, reasons.length ? 'BLOCKED' : 'READY');
}

export const websiteSalesClosureAnalysisInputSchema = z.strictObject({ scope: enablementScopeSchema,
  minimumSampleSize: z.number().int().min(1).max(500),
  cohort: z.array(z.strictObject({ workflow: canonicalEnablementWorkflowSchema, cohortAssignmentId: enablementUuid,
    industryCode: industryCodeSchema.nullable(), reason: canonicalEnablementRecordSchema(closureReasonSchema).nullable() })).max(500) });
export function analyzeWebsiteSalesClosures(raw: unknown, now: string) {
  enablementTime.parse(now); const input = websiteSalesClosureAnalysisInputSchema.parse(raw);
  if (new Set(input.cohort.map(row => row.workflow.workflowId)).size !== input.cohort.length || new Set(input.cohort.map(row => row.cohortAssignmentId)).size !== input.cohort.length) fail('ENABLEMENT_DUPLICATE_COHORT_ORIGIN');
  const groups = new Map<string, { originalDenominator: number; won: number; lost: number; unresolved: number; reasonUnknown: number; reasons: Record<string, number> }>();
  for (const row of input.cohort) {
    const identity = row.workflow.identity;
    if (identity.workspaceId !== input.scope.workspaceId || identity.projectId !== input.scope.projectId || Date.parse(row.workflow.observedAt) > Date.parse(now)) fail('ENABLEMENT_FOREIGN_OR_FUTURE_COHORT');
    const key = row.industryCode ?? 'UNKNOWN', group = groups.get(key) ?? { originalDenominator: 0, won: 0, lost: 0, unresolved: 0, reasonUnknown: 0, reasons: {} };
    group.originalDenominator++;
    if (row.workflow.status === 'WON') group.won++; else if (row.workflow.status === 'LOST') group.lost++; else group.unresolved++;
    if (row.reason) {
      const record = row.reason;
      if (!equal(record.identity, identity) || record.workflowVersion !== row.workflow.version || record.digest !== websiteSalesEnablementRecordDigest(record)
        || record.revokedAt !== null || !current(record.createdAt, record.validUntil, now) || Date.parse(record.payload.validUntil) <= Date.parse(now)
        || sourceReasons(record.payload.sourceReferences, now).length) fail('ENABLEMENT_CURRENT_CLOSURE_REASON_REQUIRED');
      if (!['WON', 'LOST'].includes(row.workflow.status)) fail('ENABLEMENT_CANONICAL_RESULT_REQUIRED');
      const reason = record.payload.reasonCode; group.reasons[reason] = (group.reasons[reason] ?? 0) + 1;
      if (reason === 'UNKNOWN') group.reasonUnknown++;
    } else group.reasonUnknown++;
    groups.set(key, group);
  }
  const segments = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([industryCode, values]) => ({ industryCode, ...values,
    sampleAssessment: values.won + values.lost < input.minimumSampleSize ? 'SMALL_SAMPLE' as const : 'DESCRIPTIVE_ONLY' as const,
    winRateBps: values.won + values.lost < input.minimumSampleSize ? null : Math.round(values.won * 10_000 / (values.won + values.lost)), causalClaim: false as const }));
  return result({ originalDenominator: input.cohort.length, segments, forecast: null, causalClaim: false as const }, []);
}

export const websiteSalesCareInputSchema = z.strictObject({ planKey: carePlanKeySchema, basis: canonicalEnablementRecordSchema(careBasisSchema) });
/** Calendar months from the owner-recorded service start, evaluated at the planned review, in UTC. */
function serviceMonth(startAt: string, reviewAt: string): number {
  const start = new Date(startAt), review = new Date(reviewAt);
  let months = (review.getUTCFullYear() - start.getUTCFullYear()) * 12 + review.getUTCMonth() - start.getUTCMonth();
  const anniversary = new Date(start);
  anniversary.setUTCDate(1); anniversary.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(anniversary); lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  anniversary.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));
  if (review.valueOf() < anniversary.valueOf()) months--;
  return months + 1;
}
export function proposeWebsiteSalesCare(raw: unknown, rawContext: unknown, now: string): EnablementEvaluation<WebsiteCareProposal> {
  const ctx = context(rawContext, now), input = websiteSalesCareInputSchema.parse(raw);
  const basis = verifyWebsiteSalesEnablementRecord(input.basis, careBasisSchema, ctx, now), reasons = sourceReasons(basis.payload.sourceReferences, now);
  const delivery = ctx.tasks.find(row => row.taskId === basis.payload.canonicalDeliveryTaskId);
  if (!delivery || delivery.status !== 'DONE') reasons.push('CANONICAL_COMPLETED_DELIVERY_REQUIRED');
  if (ctx.workflow.status !== 'WON') reasons.push('CANONICAL_WON_WEBSITE_WORKFLOW_REQUIRED');
  if (!basis.payload.planKeys.includes(input.planKey) || Date.parse(basis.payload.validUntil) <= Date.parse(now)) reasons.push('CURRENT_RECORDED_CARE_NEED_REQUIRED');
  const renewal = basis.payload.renewal;
  if (renewal) {
    reasons.push(...sourceReasons(renewal.sourceReferences, now));
    if (Date.parse(renewal.reviewAt) < Date.parse(renewal.serviceStartAt)) reasons.push('CARE_REVIEW_PRECEDES_SERVICE_START');
  }
  if (reasons.length || !delivery) return result<WebsiteCareProposal>(null, reasons, 'BLOCKED');
  const month = renewal ? serviceMonth(renewal.serviceStartAt, renewal.reviewAt) : 1;
  const schedule = CANONICAL_WEBSITE_SALES_CATALOG.care[input.planKey].filter(row => row.throughMonth === null || row.throughMonth >= month)
    .map(row => ({ ...row, fromMonth: Math.max(row.fromMonth, month) }));
  return result(websiteSalesCareProposalSchema.parse({ planKey: input.planKey, basisId: basis.id, basisDigest: basis.digest, deliveryTaskId: delivery.taskId, deliveryTaskVersion: delivery.version,
    catalogDigest: CANONICAL_WEBSITE_SALES_CATALOG.sourceDigest, currency: 'EUR', schedule,
    renewal: renewal ? { canonicalAcceptedCareOfferId: renewal.canonicalAcceptedCareOfferId, serviceStartAt: renewal.serviceStartAt,
      reviewAt: renewal.reviewAt, serviceMonth: month, sourceConfidence: 'OPERATOR_RECORDED' } : null,
    finalOfferApprovalRequired: true, autoRenewalAllowed: false, invoiceAllowed: false, contractExecutionAllowed: false }), []);
}

export const websiteSalesDayInputSchema = z.strictObject({ scope: enablementScopeSchema, resources: z.array(enablementIdentitySchema).min(1).max(50),
  tasks: z.array(canonicalEnablementTaskSchema).max(1_000) });
/** Day bins use UTC; no local device clock or invented customer-agreed date enters canonical task facts. */
export function prioritizeWebsiteSalesDay(raw: unknown, now: string): EnablementEvaluation<WebsiteDailyPriority[]> {
  enablementTime.parse(now); const input = websiteSalesDayInputSchema.parse(raw), today = new Date(now).toISOString().slice(0, 10);
  if (new Set(input.tasks.map(row => row.taskId)).size !== input.tasks.length) fail('ENABLEMENT_DUPLICATE_DAILY_TASK');
  const resources = new Set(input.resources.map(row => websiteSalesEnablementDigest(row)));
  if (input.resources.some(row => row.workspaceId !== input.scope.workspaceId || row.projectId !== input.scope.projectId)
    || input.tasks.some(row => !resources.has(websiteSalesEnablementDigest(row.identity)) || Date.parse(row.observedAt) > Date.parse(now))) fail('ENABLEMENT_DAILY_SCOPE_OR_FUTURE_DENIED');
  const order = { OVERDUE: 0, DUE_TODAY: 1, BLOCKED: 2, UPCOMING: 3, UNSCHEDULED: 4 };
  const rows = input.tasks.filter(row => !['DONE', 'CANCELLED'].includes(row.status)).map(row => {
    const priority: WebsiteDailyPriority['priority'] = row.status === 'BLOCKED' ? 'BLOCKED' : row.dueAt === null ? 'UNSCHEDULED'
      : new Date(row.dueAt).toISOString().slice(0, 10) < today ? 'OVERDUE' : new Date(row.dueAt).toISOString().slice(0, 10) === today ? 'DUE_TODAY' : 'UPCOMING';
    return { taskId: row.taskId, taskVersion: row.version, identity: row.identity, title: row.title, dueAt: row.dueAt, status: row.status,
      priority, reasons: [priority, ...(row.blockedReason ? ['CANONICAL_BLOCKER_RECORDED'] : [])] };
  }).sort((a, b) => order[a.priority] - order[b.priority] || (a.dueAt ?? 'z').localeCompare(b.dueAt ?? 'z') || a.taskId.localeCompare(b.taskId));
  return result(rows, []);
}

const hygieneOrganization = z.strictObject({ id: enablementUuid, scope: enablementScopeSchema, version: z.number().int().positive().safe(), name: enablementText,
  domain: enablementText.nullable(), registrationId: enablementText.nullable(), locationIds: z.array(enablementUuid).max(100) });
const hygieneContact = z.strictObject({ id: enablementUuid, scope: enablementScopeSchema, version: z.number().int().positive().safe(),
  companyId: enablementUuid, displayName: enablementText, email: enablementText.nullable() });
export const websiteSalesHygieneInputSchema = z.strictObject({ scope: enablementScopeSchema, observedAt: enablementTime, validUntil: enablementTime,
  organizations: z.array(hygieneOrganization).max(200), contacts: z.array(hygieneContact).max(500) });
const normalizeName = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function normalizeDomain(raw: string | null): string | null {
  if (raw === null) return null;
  try { const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}
export function scanWebsiteSalesHygiene(raw: unknown, now: string): EnablementEvaluation<WebsiteHygieneCandidate[]> {
  enablementTime.parse(now); const input = websiteSalesHygieneInputSchema.parse(raw);
  if (!current(input.observedAt, input.validUntil, now)) return result<WebsiteHygieneCandidate[]>(null, ['CURRENT_CANONICAL_HYGIENE_SNAPSHOT_REQUIRED'], 'BLOCKED');
  for (const row of [...input.organizations, ...input.contacts]) if (websiteSalesEnablementDigest(row.scope) !== websiteSalesEnablementDigest(input.scope)) fail('ENABLEMENT_HYGIENE_FOREIGN_SCOPE');
  if (new Set(input.organizations.map(row => row.id)).size !== input.organizations.length || new Set(input.contacts.map(row => row.id)).size !== input.contacts.length) fail('ENABLEMENT_HYGIENE_DUPLICATE_ID');
  input.organizations.sort((a, b) => a.id.localeCompare(b.id)); input.contacts.sort((a, b) => a.id.localeCompare(b.id));
  const candidates: WebsiteHygieneCandidate[] = []; let truncated = false;
  const add = (kind: WebsiteHygieneCandidate['kind'], a: { id: string; version: number }, b: { id: string; version: number }, reasons: string[]) => {
    const rows = [a, b].sort((x, y) => x.id.localeCompare(y.id)), body = { kind, recordIds: rows.map(row => row.id), recordVersions: rows.map(row => row.version), reasons,
      autoMergeAllowed: false as const, realRecordMutationAllowed: false as const };
    if (candidates.length < 200) candidates.push({ ...body, candidateDigest: websiteSalesEnablementDigest({ scope: input.scope, ...body }) });
    else truncated = true;
  };
  for (let i = 0; i < input.organizations.length; i++) for (const b of input.organizations.slice(i + 1)) {
    const a = input.organizations[i]!, ar = a.registrationId?.normalize('NFKC').trim().toUpperCase() ?? null, br = b.registrationId?.normalize('NFKC').trim().toUpperCase() ?? null;
    if (ar && br && ar !== br) continue;
    const sameName = normalizeName(a.name) === normalizeName(b.name), ad = normalizeDomain(a.domain), bd = normalizeDomain(b.domain);
    if (ar && ar === br) add('ORGANIZATION', a, b, ['EXACT_RECORDED_REGISTRATION_ID', 'HUMAN_REVIEW_REQUIRED']);
    else if (sameName && ad && ad === bd) add('ORGANIZATION', a, b, ['NORMALIZED_NAME_AND_DOMAIN', 'SHARED_DOMAIN_OR_BRANCH_NOT_PROOF', 'HUMAN_REVIEW_REQUIRED']);
    else if (sameName && !ad && !bd) add('ORGANIZATION', a, b, ['NORMALIZED_NAME_ONLY_WEAK_SIGNAL', 'HUMAN_REVIEW_REQUIRED']);
  }
  for (let i = 0; i < input.contacts.length; i++) for (const b of input.contacts.slice(i + 1)) {
    const a = input.contacts[i]!, sameEmail = a.email !== null && b.email !== null && a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
    if (a.companyId === b.companyId && sameEmail && normalizeName(a.displayName) === normalizeName(b.displayName)) add('CONTACT', a, b, ['SAME_COMPANY_NAME_AND_RECORDED_EMAIL', 'SHARED_MAILBOX_NOT_IDENTITY_PROOF', 'HUMAN_REVIEW_REQUIRED']);
  }
  return result(candidates.sort((a, b) => a.candidateDigest.localeCompare(b.candidateDigest)), truncated ? ['HYGIENE_RESULT_LIMIT_NARROW_SCOPE_REQUIRED'] : []);
}

/** Source-only check for the derived internal catalog. Changing the source does not silently authorize new prices. */
export function verifyWebsiteSalesCatalogSource(markdown: string): void {
  if (websiteSalesEnablementTextDigest(markdown.replace(/\r\n/g, '\n')) !== CANONICAL_WEBSITE_SALES_CATALOG.sourceDigest) fail('ENABLEMENT_CANONICAL_CATALOG_SOURCE_CHANGED');
  for (const value of ['EUR 790 ex VAT', 'EUR 1,990 ex VAT', 'EUR 3,490 ex VAT', 'EUR 39/month for the first 12 months, then EUR 99/month', 'EUR 149/month', 'EUR 229/month']) {
    if (!markdown.includes(value)) fail('ENABLEMENT_CANONICAL_CATALOG_PRICE_CHANGED');
  }
}
export function websiteSalesEnablementTextDigest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
