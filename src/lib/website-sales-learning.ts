import { improvementInputSchema, websiteSalesOperationsDigest, websiteSalesPolicyDigest } from './website-sales-operations-contracts.js';
import { proposeWebsiteSalesImprovement, summarizeWebsiteSalesOutcomes } from './website-sales-operations-outcomes.js';

/** A descriptive defensive recommendation, never a claim that price caused a loss or permission to change a rule. */
export function recommendWebsiteSalesImprovementValue(raw: unknown, now: string) {
  const input = improvementInputSchema.omit({ proposedValue: true }).parse(raw), report = summarizeWebsiteSalesOutcomes(input.cohort, now);
  const losses = report.results.filter(row => row.realizedProfitMinor !== null && row.realizedProfitMinor < 0);
  const increase = input.rule.permittedField === 'MIN_MARGIN_BPS';
  const remaining = increase ? input.rule.maximumValue - input.rule.currentValue : input.rule.currentValue - input.rule.minimumValue;
  const change = Math.max(0, Math.min(input.rule.maximumAbsoluteChange, remaining));
  const proposedValue = losses.length ? input.rule.currentValue + (increase ? change : -change) : input.rule.currentValue;
  const candidate = proposeWebsiteSalesImprovement({ ...input, proposedValue }, now);
  const status = candidate.status === 'BLOCKED' ? 'BLOCKED' as const : losses.length && change > 0 ? 'REQUIRES_REVIEW' as const : 'NO_CHANGE' as const;
  const body = { contractVersion: 'website-sales-learning-v1' as const, status, proposedValue,
    currentValue: input.rule.currentValue, field: input.rule.permittedField, ruleDigest: websiteSalesPolicyDigest(input.rule), cohortDigest: report.cohortDigest,
    completedLossSamples: losses.length, completedSamples: report.completedProfitSamples, originalDenominator: report.denominator,
    basis: status === 'REQUIRES_REVIEW' ? 'COMPLETED_ACTUAL_LOSSES_TIGHTEN_APPROVED_LIMIT' as const : 'NO_ELIGIBLE_DEFENSIVE_CHANGE' as const,
    reasons: candidate.reasons, causalAttribution: 'NOT_ESTABLISHED' as const, financialSourceConfidence: report.sourceConfidence,
    requiresExactPromotionApproval: true as const, externalEffectAllowed: false as const, autoPromotionAllowed: false as const };
  return { ...body, recommendationDigest: websiteSalesOperationsDigest(body) };
}
