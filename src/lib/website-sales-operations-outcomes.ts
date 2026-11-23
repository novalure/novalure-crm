import { outcomeCohortSchema, outcomeSourceSchema, improvementInputSchema, operationsApprovalSchema, opsTime,
  operationsCurrent, operationsFail, operationsImmutable, operationsPolicyReasons, operationsSafe, operationsScopeEqual,
  websiteSalesOperationsContract, websiteSalesOperationsDigest, websiteSalesPolicyDigest, type OutcomeSource } from './website-sales-operations-contracts.js';

export function websiteSalesOutcomeSourceDigest(source: Omit<OutcomeSource, 'sourceDigest'> | OutcomeSource): string {
  const { sourceDigest, ...body } = source as OutcomeSource; void sourceDigest; return websiteSalesOperationsDigest(body);
}
const cashKinds = new Set(['PAYMENT', 'ADVANCE_RECEIVED', 'REFUND', 'COST', 'COST_REVERSAL']);
const moneyKinds = new Set([...cashKinds, 'ADVANCE_APPLIED', 'OBLIGATION', 'OBLIGATION_RELEASE']);
const coverageKinds = new Set(['PAYMENTS_COMPLETE', 'COSTS_COMPLETE']);
/** Existing Finance distinction preserved: actual cash, approved commitments and unknown coverage are never a sales forecast. */
export function summarizeWebsiteSalesOutcomes(raw: unknown, now: string) {
  const input = outcomeCohortSchema.parse(raw); opsTime.parse(now);
  const origins = new Map(input.origins.map(origin => [origin.opportunityId, origin]));
  if (origins.size !== input.origins.length || new Set(input.origins.map(origin => origin.cohortAssignmentId)).size !== input.origins.length) operationsFail('OPERATIONS_DUPLICATE_COHORT_ORIGIN');
  for (const origin of input.origins) if (!operationsScopeEqual(origin.identity, input.scope) || Date.parse(origin.enteredAt) > Date.parse(now)) operationsFail('OPERATIONS_COHORT_SCOPE_OR_TIME');
  const sources = new Map<string, OutcomeSource>(), eventIds = new Map<string, string>();
  for (const event of input.events) {
    const source = outcomeSourceSchema.parse(event.source), origin = origins.get(source.origin.opportunityId), hash = websiteSalesOperationsDigest(event);
    if (eventIds.has(event.eventId) && eventIds.get(event.eventId) !== hash) operationsFail('OPERATIONS_EVENT_ID_CONFLICT'); eventIds.set(event.eventId, hash);
    const original = origin && { identity: origin.identity, opportunityId: origin.opportunityId, cohortAssignmentId: origin.cohortAssignmentId, attributionDigest: origin.attributionDigest };
    if (!original || websiteSalesOperationsDigest(original) !== websiteSalesOperationsDigest(source.origin)) operationsFail('OPERATIONS_ORIGINAL_ATTRIBUTION_MISMATCH');
    if (source.sourceDigest !== websiteSalesOutcomeSourceDigest(source)) operationsFail('OPERATIONS_FINANCIAL_SOURCE_HASH');
    if (Date.parse(source.observedAt) < Date.parse(origin!.enteredAt) || Date.parse(source.occurredAt) > Date.parse(source.observedAt)
      || Date.parse(source.observedAt) > Date.parse(now)) operationsFail('OPERATIONS_FINANCIAL_SOURCE_TIME');
    if (moneyKinds.has(source.kind)) {
      if (source.amountMinor === null || source.sourceSystem === 'CRM' || !source.approvalReference
        || source.sourceConfidence !== 'OPERATOR_RECORDED_FINANCIAL_DOCUMENT') operationsFail('OPERATIONS_FINANCIAL_DOCUMENT_REQUIRED');
      const requiredBasis = ['OBLIGATION', 'OBLIGATION_RELEASE'].includes(source.kind) ? 'APPROVED_COMMITMENT' : 'SETTLED_ACTUAL';
      if (source.basis !== requiredBasis) operationsFail('OPERATIONS_ACTUAL_VS_COMMITMENT_REQUIRED');
    } else if (source.amountMinor !== null || source.relatedSourceId !== null) operationsFail('OPERATIONS_NONFINANCIAL_AMOUNT_DENIED');
    else if (coverageKinds.has(source.kind)) {
      if (source.sourceSystem !== 'APPROVED_MANUAL' || !source.approvalReference || source.sourceConfidence !== 'OPERATOR_RECORDED_FINANCIAL_DOCUMENT') operationsFail('OPERATIONS_COVERAGE_ATTESTATION_REQUIRED');
    } else if (source.sourceSystem !== 'CRM' || source.sourceConfidence !== 'CRM_CANONICAL_EVENT' || source.basis !== 'CRM_OBSERVATION') operationsFail('OPERATIONS_CRM_OUTCOME_SOURCE_REQUIRED');
    const previous = sources.get(source.sourceId);
    if (previous && previous.sourceDigest !== source.sourceDigest) operationsFail('OPERATIONS_SOURCE_ID_CONFLICT'); sources.set(source.sourceId, source);
  }
  const records = new Map<string, OutcomeSource[]>();
  for (const source of sources.values()) { const key = source.economicEventId; const rows = records.get(key) ?? []; rows.push(source); records.set(key, rows); }
  const providerRecords = new Map<string, string>();
  for (const source of sources.values()) {
    const key = `${source.sourceSystem}:${source.recordId}`, assigned = providerRecords.get(key);
    if (assigned && assigned !== source.economicEventId) operationsFail('OPERATIONS_DUPLICATE_ECONOMIC_EVENT'); providerRecords.set(key, source.economicEventId);
  }
  const heads = new Map<string, OutcomeSource>(), aliases = new Map<string, string>();
  for (const rows of records.values()) {
    rows.sort((a, b) => a.recordVersion - b.recordVersion);
    for (let index = 0; index < rows.length; index++) {
      const source = rows[index]!, prior = rows[index - 1];
      if (!prior ? source.recordVersion !== 1 || source.previousSourceDigest !== null || source.supersedesSourceId !== null
        : source.recordVersion !== prior.recordVersion + 1 || source.previousSourceDigest !== prior.sourceDigest || source.supersedesSourceId !== prior.sourceId
          || source.kind !== prior.kind || websiteSalesOperationsDigest(source.origin) !== websiteSalesOperationsDigest(prior.origin)
          || source.sourceSystem !== prior.sourceSystem || source.recordId !== prior.recordId
          || Date.parse(source.observedAt) < Date.parse(prior.observedAt)) operationsFail('OPERATIONS_CORRECTION_CHAIN');
    }
    const head = rows.at(-1)!; heads.set(head.sourceId, head); for (const row of rows) aliases.set(row.sourceId, head.sourceId);
  }
  const used = new Map<string, bigint>();
  function related(source: OutcomeSource, kinds: string[]): OutcomeSource {
    const target = source.relatedSourceId ? heads.get(aliases.get(source.relatedSourceId) ?? '') : undefined;
    if (!target || !kinds.includes(target.kind) || target.sourceId === source.sourceId
      || websiteSalesOperationsDigest(target.origin) !== websiteSalesOperationsDigest(source.origin)
      || Date.parse(target.occurredAt) > Date.parse(source.occurredAt)) operationsFail('OPERATIONS_RELATED_SOURCE_BINDING');
    return target;
  }
  function consume(source: OutcomeSource, kinds: string[]): OutcomeSource {
    const target = related(source, kinds);
    const total = (used.get(target.sourceId) ?? BigInt(0)) + BigInt(source.amountMinor!);
    // Obligation settlements may be reversed in the same snapshot. Validate their net use after all linked facts.
    if (target.kind !== 'OBLIGATION' && total > BigInt(target.amountMinor!)) operationsFail('OPERATIONS_REVERSAL_OR_ALLOCATION_EXCEEDS_SOURCE');
    used.set(target.sourceId, total); return target;
  }
  const ordered = [...heads.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.sourceId.localeCompare(b.sourceId));
  const results = input.origins.map(origin => {
    const own = ordered.filter(source => source.origin.opportunityId === origin.opportunityId);
    const obligationReversals = new Map<string, bigint>();
    let payments = BigInt(0), advances = BigInt(0), applied = BigInt(0), refunds = BigInt(0), recognizedRefunds = BigInt(0), cost = BigInt(0), obligations = BigInt(0), obligationReductions = BigInt(0), advanceRefunds = BigInt(0);
    for (const source of own) {
      const amount = BigInt(source.amountMinor ?? 0);
      switch (source.kind) {
        case 'PAYMENT': if (source.relatedSourceId) operationsFail('OPERATIONS_PAYMENT_RELATED_SOURCE_DENIED'); payments += amount; break;
        case 'ADVANCE_RECEIVED': if (source.relatedSourceId) operationsFail('OPERATIONS_ADVANCE_RELATED_SOURCE_DENIED'); advances += amount; break;
        case 'ADVANCE_APPLIED': consume(source, ['ADVANCE_RECEIVED']); applied += amount; break;
        case 'REFUND': { const target = consume(source, ['PAYMENT', 'ADVANCE_RECEIVED', 'ADVANCE_APPLIED']); refunds += amount;
          if (target.kind === 'ADVANCE_RECEIVED') advanceRefunds += amount; else recognizedRefunds += amount; break; }
        case 'COST': cost += amount; if (source.relatedSourceId) { consume(source, ['OBLIGATION']); obligationReductions += amount; } break;
        case 'COST_REVERSAL': {
          const reversedCost = consume(source, ['COST']); cost -= amount;
          if (reversedCost.relatedSourceId) {
            const obligation = related(reversedCost, ['OBLIGATION']);
            obligationReversals.set(obligation.sourceId, (obligationReversals.get(obligation.sourceId) ?? BigInt(0)) + amount);
            obligationReductions -= amount;
          }
          break;
        }
        case 'OBLIGATION': if (source.relatedSourceId) operationsFail('OPERATIONS_OBLIGATION_RELATED_SOURCE_DENIED'); obligations += amount; break;
        case 'OBLIGATION_RELEASE': consume(source, ['OBLIGATION']); obligationReductions += amount; break;
      }
    }
    for (const obligation of own.filter(source => source.kind === 'OBLIGATION')) {
      const settled = (used.get(obligation.sourceId) ?? BigInt(0)) - (obligationReversals.get(obligation.sourceId) ?? BigInt(0));
      if (settled < BigInt(0) || settled > BigInt(obligation.amountMinor!)) operationsFail('OPERATIONS_REVERSAL_OR_ALLOCATION_EXCEEDS_SOURCE');
    }
    const advanceLiability = advances - applied - advanceRefunds, outstandingObligations = obligations - obligationReductions;
    const cashDelta = payments + advances - refunds - cost, recognizedContribution = payments + applied - recognizedRefunds - cost;
    const terminalEvents = own.filter(source => ['FULFILLED', 'ABANDONED', 'NO_RESPONSE'].includes(source.kind));
    const latestTerminal = terminalEvents.at(-1), outcomeConflict = Boolean(latestTerminal && terminalEvents.some(source => source.kind !== latestTerminal.kind
      && Date.parse(source.occurredAt) === Date.parse(latestTerminal.occurredAt)));
    const terminalKind = outcomeConflict ? null : latestTerminal?.kind ?? null, terminal = terminalKind !== null;
    const financialObservedAt = Math.max(0, ...own.filter(source => moneyKinds.has(source.kind)).map(source => Date.parse(source.observedAt)));
    const complete = own.some(source => source.kind === 'PAYMENTS_COMPLETE' && Date.parse(source.observedAt) >= financialObservedAt)
      && own.some(source => source.kind === 'COSTS_COMPLETE' && Date.parse(source.observedAt) >= financialObservedAt);
    const reasons: string[] = [];
    if (!complete) reasons.push('ACTUAL_COST_AND_PAYMENT_COVERAGE_UNKNOWN');
    if (!terminal) reasons.push('OUTCOME_NOT_TERMINAL');
    if (outcomeConflict) reasons.push('CONFLICTING_CURRENT_OUTCOMES');
    if (terminalKind !== 'FULFILLED' && payments + applied - recognizedRefunds > BigInt(0)) reasons.push('FULFILLMENT_NOT_PROVEN_FOR_PAID_OPPORTUNITY');
    if (advanceLiability > BigInt(0) || outstandingObligations > BigInt(0)) reasons.push('OPEN_OBLIGATIONS_OR_UNEARNED_ADVANCES');
    return { origin, paymentMinor: operationsSafe(payments), advanceReceivedMinor: operationsSafe(advances), advanceAppliedMinor: operationsSafe(applied),
      refundsMinor: operationsSafe(refunds), actualCostMinor: operationsSafe(cost), outstandingObligationsMinor: operationsSafe(outstandingObligations),
      unearnedAdvanceMinor: operationsSafe(advanceLiability), observedCashDeltaMinor: operationsSafe(cashDelta),
      realizedProfitMinor: reasons.length ? null : operationsSafe(recognizedContribution), reasons, terminal,
      terminalKind, outcomeConflict, nonresponse: terminalKind === 'NO_RESPONSE', abandoned: terminalKind === 'ABANDONED',
      hadNonresponse: own.some(source => source.kind === 'NO_RESPONSE'), hadAbandoned: own.some(source => source.kind === 'ABANDONED'),
      activeSourceDigests: own.map(source => source.sourceDigest).sort() };
  }).sort((a, b) => a.origin.opportunityId.localeCompare(b.origin.opportunityId));
  const result = { contractVersion: websiteSalesOperationsContract, kind: 'OUTCOME_COHORT' as const, scope: input.scope, revision: input.revision,
    denominator: input.origins.length, terminalCount: results.filter(item => item.terminal).length,
    completedProfitSamples: results.filter(item => item.realizedProfitMinor !== null).length,
    nonresponseCount: results.filter(item => item.nonresponse).length, abandonedCount: results.filter(item => item.abandoned).length,
    hadNonresponseCount: results.filter(item => item.hadNonresponse).length, hadAbandonedCount: results.filter(item => item.hadAbandoned).length,
    results, sourceHistoryDigest: websiteSalesOperationsDigest([...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId))),
    profitPrediction: null, sourceConfidence: 'OPERATOR_RECORDED_FINANCIAL_DOCUMENT_NOT_BANK_VERIFIED' as const,
    externalEffectAllowed: false as const, autoPromotionAllowed: false as const };
  return operationsImmutable({ ...result, cohortDigest: websiteSalesOperationsDigest(result) });
}

export function proposeWebsiteSalesImprovement(raw: unknown, now: string) {
  const input = improvementInputSchema.parse(raw); opsTime.parse(now);
  const cohort = summarizeWebsiteSalesOutcomes(input.cohort, now), reasons = operationsPolicyReasons(input.rule, input.scope, now);
  if (!operationsScopeEqual(input.scope, input.cohort.scope)) operationsFail('OPERATIONS_IMPROVEMENT_SCOPE');
  if (cohort.completedProfitSamples < input.rule.minimumCompletedSamples) reasons.push('INSUFFICIENT_COMPLETED_ACTUAL_SAMPLES');
  if (cohort.completedProfitSamples * 10_000 < input.rule.minimumCoverageBps * cohort.denominator) reasons.push('INSUFFICIENT_ORIGINAL_COHORT_COVERAGE');
  if (input.rule.minimumValue > input.rule.maximumValue || input.rule.currentValue < input.rule.minimumValue || input.rule.currentValue > input.rule.maximumValue) operationsFail('OPERATIONS_IMPROVEMENT_RULE_RANGE');
  if (input.proposedValue < input.rule.minimumValue || input.proposedValue > input.rule.maximumValue
    || Math.abs(input.proposedValue - input.rule.currentValue) > input.rule.maximumAbsoluteChange) reasons.push('CHANGE_OUTSIDE_APPROVED_BOUNDS');
  if (input.rule.permittedField !== 'MAX_OPPORTUNITY_COST_MINOR' && input.proposedValue > 10_000) reasons.push('BASIS_POINTS_RANGE');
  const result = { contractVersion: websiteSalesOperationsContract, kind: 'IMPROVEMENT_PROPOSAL' as const, scope: input.scope, revision: input.revision,
    ruleId: input.rule.policyId, ruleVersion: input.rule.revision.version, ruleDigest: websiteSalesPolicyDigest(input.rule), cohortDigest: cohort.cohortDigest,
    denominator: cohort.denominator, completedSamples: cohort.completedProfitSamples, field: input.rule.permittedField,
    observedRealizedProfitMinor: operationsSafe(cohort.results.reduce((sum, result) => sum + BigInt(result.realizedProfitMinor ?? 0), BigInt(0))),
    unknownProfitSamples: cohort.results.filter(result => result.realizedProfitMinor === null).length,
    currentValue: input.rule.currentValue, proposedValue: input.proposedValue, createdAt: now,
    status: reasons.length ? 'BLOCKED' as const : 'REQUIRES_PROMOTION_APPROVAL' as const, reasons,
    autoPromotionAllowed: false as const, externalEffectAllowed: false as const };
  return operationsImmutable({ ...result, proposalDigest: websiteSalesOperationsDigest(result) });
}
export type WebsiteSalesImprovementProposal = ReturnType<typeof proposeWebsiteSalesImprovement>;
export function evaluateWebsiteSalesImprovementPromotion(proposal: WebsiteSalesImprovementProposal, current: unknown, rawApproval: unknown, now: string) {
  const approval = operationsApprovalSchema.nullable().parse(rawApproval), fresh = proposeWebsiteSalesImprovement(current, now);
  const { proposalDigest, ...unsigned } = proposal;
  if (proposalDigest !== websiteSalesOperationsDigest(unsigned)) operationsFail('OPERATIONS_IMPROVEMENT_INTEGRITY');
  const reasons = [...fresh.reasons];
  if (proposal.status === 'BLOCKED' || fresh.ruleDigest !== proposal.ruleDigest || fresh.cohortDigest !== proposal.cohortDigest
    || fresh.proposedValue !== proposal.proposedValue || websiteSalesOperationsDigest(fresh.scope) !== websiteSalesOperationsDigest(proposal.scope)
    || Date.parse(proposal.createdAt) > Date.parse(now) || proposeWebsiteSalesImprovement(current, proposal.createdAt).proposalDigest !== proposalDigest) reasons.push('CURRENT_RULE_COHORT_AND_PROPOSAL_REQUIRED');
  if (!approval || approval.contentDigest !== proposalDigest || !operationsCurrent(approval.approvedAt, approval.validUntil, now)) reasons.push('EXACT_PROMOTION_APPROVAL_REQUIRED');
  return operationsImmutable({ status: reasons.length ? 'BLOCKED' as const : 'ELIGIBLE_FOR_SERVER_PROMOTION' as const, proposalDigest,
    expectedRuleDigest: proposal.ruleDigest, expectedCohortDigest: proposal.cohortDigest, reasons,
    requiresAtomicServerCAS: true as const, autoPromotionAllowed: false as const, externalEffectAllowed: false as const });
}
export const websiteSalesOutcomeSourceInputSchema = outcomeSourceSchema;
