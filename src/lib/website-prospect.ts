import { z } from 'zod';
import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(1_000);
const publicUrl = z.url().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'An HTTPS source without credentials is required');
export const websiteProspectIdentitySchema = z.strictObject({ workspaceId: uuid, projectId: uuid, companyId: uuid, locationId: uuid });
const evidenceSchema = z.strictObject({
  evidenceId: z.string().trim().min(1).max(100),
  identity: websiteProspectIdentitySchema,
  kind: z.enum(['IDENTITY', 'OWN_WEBSITE_SEARCH', 'OBSTACLE', 'PLATFORM_PRESENCE', 'BOOKING_ROUTE', 'BUSINESS_NEED']),
  sourceUrl: publicUrl, observedAt: timestamp, validUntil: timestamp,
  validityCondition: text, finding: text, confidence: z.number().min(0).max(1)
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt), 'Evidence validity must follow observation');
const domainSchema = z.string().trim().toLowerCase().refine(value => {
  try { const url = new URL(`https://${value}`); return url.hostname === value && value.includes('.') && url.pathname === '/' && !url.search && !url.hash && !url.port && !url.username; }
  catch { return false; }
}, 'A domain hostname is required');
export const websiteProspectInputSchema = z.strictObject({
  identity: websiteProspectIdentitySchema, country: z.literal('IRELAND'), identityStatus: z.enum(['VERIFIED', 'AMBIGUOUS']),
  domain: domainSchema.nullable().optional(), path: z.enum(['NO_WEBSITE', 'WEBSITE_OBSTACLE', 'PLATFORM_PRIMARY']),
  ownWebsiteSearch: z.enum(['NONE_FOUND', 'FOUND', 'UNCLEAR']),
  obstacle: z.enum(['CONFIRMED_REPRODUCIBLE', 'TRANSIENT', 'OLD_DESIGN_ONLY', 'UNCONFIRMED']).nullable(),
  platformUrl: publicUrl.nullable(), bookingRoute: z.enum(['CHECKED_WORKING', 'CHECKED_BROKEN', 'UNKNOWN']),
  need: z.enum(['EVIDENCED', 'NOT_ESTABLISHED']), evidence: z.array(evidenceSchema).min(1).max(50)
}).refine(value => new Set(value.evidence.map(item => item.evidenceId)).size === value.evidence.length, 'Duplicate evidence identifiers');

export type WebsiteProspectIdentity = z.infer<typeof websiteProspectIdentitySchema>;
export type WebsiteProspectInput = z.infer<typeof websiteProspectInputSchema>;
export type WebsiteProspectEvidence = z.infer<typeof evidenceSchema>;
export interface WebsiteProspectQualification {
  readonly identity: WebsiteProspectIdentity;
  readonly identityKey: string;
  readonly evidenceDigest: string;
  readonly status: 'READY' | 'NEEDS_CLARIFICATION' | 'NURTURE';
  readonly reasons: readonly string[];
  readonly validUntil: string;
  readonly contactPermission: false;
  readonly profitPrediction: null;
  readonly input: WebsiteProspectInput;
}

/** Pure diagnosis: caller-supplied observations remain untrusted and grant no business authority. */
export function qualifyWebsiteProspect(raw: unknown, now: string): WebsiteProspectQualification {
  const input = websiteProspectInputSchema.parse(raw);
  const at = Date.parse(timestamp.parse(now));
  const reasons: string[] = [];
  const required = new Set<WebsiteProspectEvidence['kind']>(['IDENTITY', 'OWN_WEBSITE_SEARCH']);
  if (input.identityStatus !== 'VERIFIED') reasons.push('CRM_IDENTITY_AMBIGUOUS');
  if (input.ownWebsiteSearch === 'UNCLEAR') reasons.push('OWN_WEBSITE_SEARCH_UNCLEAR');
  if (input.path === 'NO_WEBSITE' && (input.ownWebsiteSearch !== 'NONE_FOUND' || input.domain)) reasons.push('NO_WEBSITE_FINDING_CONFLICT');
  if (input.path === 'WEBSITE_OBSTACLE') {
    required.add('OBSTACLE');
    if (!input.domain || input.ownWebsiteSearch !== 'FOUND') reasons.push('OWN_WEBSITE_NOT_VERIFIED');
    if (input.obstacle !== 'CONFIRMED_REPRODUCIBLE') reasons.push('REPRODUCIBLE_OBSTACLE_NOT_CONFIRMED');
  }
  if (input.path === 'PLATFORM_PRIMARY') {
    required.add('PLATFORM_PRESENCE'); required.add('BOOKING_ROUTE');
    if (!input.platformUrl) reasons.push('PLATFORM_SOURCE_REQUIRED');
    if (input.bookingRoute === 'UNKNOWN') reasons.push('BOOKING_ROUTE_UNCHECKED');
    if (input.ownWebsiteSearch === 'FOUND' && !input.domain) reasons.push('OWN_WEBSITE_NOT_VERIFIED');
  }
  if (input.need === 'EVIDENCED') required.add('BUSINESS_NEED');
  for (const kind of required) if (!input.evidence.some(item => item.kind === kind)) reasons.push(`EVIDENCE_REQUIRED:${kind}`);
  for (const evidence of input.evidence) {
    if (digest(evidence.identity) !== digest(input.identity)) reasons.push(`EVIDENCE_SCOPE_MISMATCH:${evidence.evidenceId}`);
    if (Date.parse(evidence.observedAt) > at) reasons.push(`FUTURE_OBSERVATION:${evidence.evidenceId}`);
    if (Date.parse(evidence.validUntil) <= at) reasons.push(`STALE_OBSERVATION:${evidence.evidenceId}`);
    if (evidence.confidence === 0) reasons.push(`NO_CONFIDENCE:${evidence.evidenceId}`);
  }
  const status = reasons.length ? 'NEEDS_CLARIFICATION' : input.need === 'EVIDENCED' ? 'READY' : 'NURTURE';
  if (status === 'NURTURE') reasons.push('BUSINESS_NEED_NOT_ESTABLISHED');
  const canonicalInput = { ...input, domain: input.domain ?? null, evidence: [...input.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) };
  return immutable({ identity: input.identity, identityKey: digest(input.identity), evidenceDigest: digest(canonicalInput), status, reasons,
    validUntil: new Date(Math.min(...input.evidence.map(item => Date.parse(item.validUntil)))).toISOString(),
    contactPermission: false, profitPrediction: null, input });
}

export interface WebsiteProspectRevalidation {
  readonly current: WebsiteProspectQualification;
  readonly valid: boolean;
  readonly reason: 'UNCHANGED' | 'IDENTITY_CHANGED' | 'EVIDENCE_CHANGED' | 'NOT_READY';
}
export function revalidateWebsiteProspect(previous: WebsiteProspectQualification, current: unknown, now: string): WebsiteProspectRevalidation {
  // Recompute the saved input rather than trusting caller-provided READY/hash fields.
  const prior = qualifyWebsiteProspect(previous.input, now);
  const next = qualifyWebsiteProspect(current, now);
  const reason = prior.identityKey !== next.identityKey ? 'IDENTITY_CHANGED'
    : previous.identityKey !== prior.identityKey || previous.evidenceDigest !== prior.evidenceDigest || prior.evidenceDigest !== next.evidenceDigest ? 'EVIDENCE_CHANGED'
      : prior.status !== 'READY' || next.status !== 'READY' ? 'NOT_READY' : 'UNCHANGED';
  return immutable({ current: next, valid: reason === 'UNCHANGED', reason });
}

const investmentSchema = z.strictObject({
  requestedStage: z.enum(['DIAGNOSIS', 'CONCEPT', 'DEMO']),
  completedStage: z.enum(['NONE', 'DIAGNOSIS', 'CONCEPT']),
  completedStageEvidence: z.strictObject({ stage: z.enum(['DIAGNOSIS', 'CONCEPT']), identityKey: z.hash('sha256'), evidenceDigest: z.hash('sha256'),
    reference: text, completedAt: timestamp }).nullable().optional(),
  estimatedCostMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  availableBudgetMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedNetPriceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  estimatedDeliveryCostMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  minimumMarginBasisPoints: z.number().int().min(0).max(10_000),
  requiredCapacityMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), availableCapacityMinutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rightsVerified: z.boolean(), budgetReference: text.nullable()
}).refine(value => value.estimatedDeliveryCostMinor === null || Number.isSafeInteger(value.estimatedDeliveryCostMinor + value.estimatedCostMinor), 'Total estimated cost must be safe integer cents');
export type WebsiteInvestmentInput = z.infer<typeof investmentSchema>;
export interface WebsiteInvestmentDecision {
  readonly stage: 'DIAGNOSIS' | 'CONCEPT' | 'DEMO';
  readonly requestedStageAllowed: boolean;
  readonly reasons: readonly string[];
  readonly estimatedMarginBasisPoints: number | null;
  readonly externalEffectAllowed: false;
  readonly spendAuthorized: false;
}
export function decideWebsiteInvestment(raw: unknown, qualification: WebsiteProspectQualification, now: string): WebsiteInvestmentDecision {
  const input = investmentSchema.parse(raw);
  const current = qualifyWebsiteProspect(qualification.input, now);
  const reasons: string[] = [];
  const estimatedMarginBasisPoints = input.expectedNetPriceMinor !== null && input.estimatedDeliveryCostMinor !== null
    ? Math.floor((1 - (input.estimatedDeliveryCostMinor + input.estimatedCostMinor) / input.expectedNetPriceMinor) * 10_000) : null;
  if (input.requestedStage !== 'DIAGNOSIS') {
    if (current.status !== 'READY') reasons.push('CURRENT_QUALIFICATION_REQUIRED');
    if (input.completedStage === 'NONE') reasons.push('DIAGNOSIS_REQUIRED');
    const completion = input.completedStageEvidence;
    if (!completion || completion.stage !== input.completedStage || completion.identityKey !== current.identityKey
      || completion.evidenceDigest !== current.evidenceDigest || Date.parse(completion.completedAt) > Date.parse(now)) reasons.push('CURRENT_STAGE_EVIDENCE_REQUIRED');
    if (!input.rightsVerified) reasons.push('ASSET_RIGHTS_REQUIRED');
  }
  if (input.estimatedCostMinor > input.availableBudgetMinor || input.estimatedCostMinor > 0 && !input.budgetReference) reasons.push('COVERED_BUDGET_REQUIRED');
  if (input.requiredCapacityMinutes > input.availableCapacityMinutes) reasons.push('CAPACITY_REQUIRED');
  if (input.requestedStage === 'DEMO') {
    if (input.completedStage !== 'CONCEPT') reasons.push('CONCEPT_REQUIRED');
    if (estimatedMarginBasisPoints === null || estimatedMarginBasisPoints <= 0 || estimatedMarginBasisPoints < input.minimumMarginBasisPoints) reasons.push('PLAUSIBLE_MARGIN_REQUIRED');
  }
  return immutable({ stage: reasons.length ? 'DIAGNOSIS' : input.requestedStage, requestedStageAllowed: reasons.length === 0, reasons,
    estimatedMarginBasisPoints, externalEffectAllowed: false, spendAuthorized: false });
}
