import { portfolioInputSchema, opsTime, operationsBindingReasons, operationsCurrent, operationsFail, operationsImmutable,
  operationsPolicyReasons, operationsSafe, websiteSalesOperationsContract, websiteSalesOperationsDigest, websiteSalesPolicyDigest } from './website-sales-operations-contracts.js';

/** C1's supplied-fact weighted assessment and B3's staged investment discipline, without synthetic CRM records or forecasts. */
export function planWebsiteSalesPortfolio(raw: unknown, now: string) {
  const input = portfolioInputSchema.parse(raw); opsTime.parse(now);
  const policyReasons = operationsPolicyReasons(input.policy, input.scope, now);
  if (!operationsCurrent(input.resources.observedAt, input.resources.validUntil, now)) policyReasons.push('CURRENT_RESOURCE_SNAPSHOT_REQUIRED');
  const byId = new Map<string, typeof input.candidates[number]>();
  for (const candidate of input.candidates) {
    const previous = byId.get(candidate.binding.opportunityId);
    if (previous && websiteSalesOperationsDigest(previous) !== websiteSalesOperationsDigest(candidate)) operationsFail('OPERATIONS_CONFLICTING_DUPLICATE_OPPORTUNITY');
    byId.set(candidate.binding.opportunityId, candidate);
  }
  const ranked = [...byId.values()].map(candidate => {
    const reasons = [...policyReasons, ...operationsBindingReasons(candidate.binding, input.scope, now)];
    const replyDialog = candidate.stopReason === 'REPLY_RECEIVED' && candidate.purpose === 'NEW_CUSTOMER_DIALOG' && candidate.dialogSourceId !== null;
    if (!['OPEN', 'QUALIFIED', 'OFFER_DRAFT'].includes(candidate.status) && !(candidate.status === 'STOPPED' && replyDialog)) reasons.push('OPPORTUNITY_NOT_ACTIVE');
    if (candidate.stopReason && !replyDialog) reasons.push('HARD_STOP_OR_OLD_FOLLOWUP_DENIED');
    if (candidate.requestedStage !== 'CONVERSATION' && candidate.qualificationStatus !== 'READY') reasons.push('CURRENT_QUALIFICATION_REQUIRED');
    if (candidate.requestedStage === 'CONVERSATION' && (candidate.purpose !== 'NEW_CUSTOMER_DIALOG' || !candidate.dialogSourceId)) reasons.push('CURRENT_CUSTOMER_DIALOG_SOURCE_REQUIRED');
    if (new Set(candidate.signals.map(signal => signal.kind)).size !== candidate.signals.length) operationsFail('OPERATIONS_DUPLICATE_SIGNAL_KIND');
    const origin = { identity: candidate.binding.identity, opportunityId: candidate.binding.opportunityId,
      cohortAssignmentId: candidate.binding.cohortAssignmentId, attributionDigest: candidate.binding.attributionDigest };
    if (candidate.signals.some(signal => websiteSalesOperationsDigest(signal.origin) !== websiteSalesOperationsDigest(origin))) operationsFail('OPERATIONS_SIGNAL_ORIGIN_MISMATCH');
    const currentSignals = candidate.signals.filter(signal => operationsCurrent(signal.observedAt, signal.validUntil, now));
    if (currentSignals.length !== candidate.signals.length) reasons.push('STALE_OR_FUTURE_SIGNAL');
    const positive = currentSignals.filter(signal => input.policy.weights[signal.kind] > 0);
    const weight = positive.reduce((sum, signal) => sum + input.policy.weights[signal.kind], 0);
    const score = weight ? Math.floor(positive.reduce((sum, signal) => sum + signal.value * input.policy.weights[signal.kind], 0) / weight) : null;
    if (positive.length < input.policy.minimumKnownSignals || score === null) reasons.push('INSUFFICIENT_KNOWN_FACTS');
    if (score !== null && score < input.policy.minimumScore) reasons.push('BELOW_PRIORITY_THRESHOLD');
    if (!['DIAGNOSIS', 'CONVERSATION'].includes(candidate.requestedStage)) {
      const prerequisite = candidate.stagePrerequisite, required = ['DEMO', 'CONCEPT_ACCEPTANCE'].includes(candidate.requestedStage) ? 'CONCEPT' : 'DIAGNOSIS';
      if (!prerequisite || prerequisite.stage !== required || prerequisite.evidenceDigest !== candidate.binding.evidenceDigest
        || Date.parse(prerequisite.completedAt) > Date.parse(now) || candidate.requestedStage === 'DEMO'
        && (!prerequisite.acceptedAt || Date.parse(prerequisite.acceptedAt) < Date.parse(prerequisite.completedAt) || Date.parse(prerequisite.acceptedAt) > Date.parse(now))) reasons.push('CURRENT_STAGE_PREREQUISITE_REQUIRED');
      if (candidate.requestedStage !== 'CONCEPT_ACCEPTANCE' && !candidate.assetRightsReference) reasons.push('ASSET_RIGHTS_REFERENCE_REQUIRED');
      if (candidate.requestedStage === 'CONCEPT_ACCEPTANCE' && candidate.estimatedCostMinor !== 0) reasons.push('INTERNAL_ACCEPTANCE_ZERO_COST_REQUIRED');
    }
    if (candidate.estimatedCostMinor > input.policy.maxCostPerOpportunityMinor || candidate.requiredMinutes > input.policy.maxMinutesPerOpportunity) reasons.push('OPPORTUNITY_CAP_EXCEEDED');
    return { candidate, score, reasons, selected: false,
      rationale: positive.map(signal => ({ kind: signal.kind, suppliedValue: signal.value, weight: input.policy.weights[signal.kind], sourceId: signal.sourceId, sourceDigest: signal.sourceDigest })) };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.candidate.binding.opportunityId.localeCompare(b.candidate.binding.opportunityId));
  let budget = BigInt(input.resources.availableBudgetMinor), capacity = BigInt(input.resources.availableMinutes), count = 0;
  const companyCounts = new Map<string, number>(), locations = new Set<string>();
  for (const row of ranked) {
    if (row.reasons.length) continue;
    const identity = row.candidate.binding.identity, location = `${identity.companyId}:${identity.locationId}`;
    if (locations.has(location)) row.reasons.push('LOCATION_ALREADY_ALLOCATED');
    if (count >= input.policy.maxOpportunities) row.reasons.push('PORTFOLIO_COUNT_CAP');
    if ((companyCounts.get(identity.companyId) ?? 0) >= input.policy.maxPerCompany) row.reasons.push('COMPANY_COUNT_CAP');
    if (BigInt(row.candidate.estimatedCostMinor) > budget) row.reasons.push('BUDGET_NOT_AVAILABLE');
    if (BigInt(row.candidate.requiredMinutes) > capacity) row.reasons.push('CAPACITY_NOT_AVAILABLE');
    if (row.reasons.length) continue;
    row.selected = true; row.reasons.push('SELECTED_FROM_CURRENT_KNOWN_FACTS'); count++; locations.add(location);
    companyCounts.set(identity.companyId, (companyCounts.get(identity.companyId) ?? 0) + 1);
    budget -= BigInt(row.candidate.estimatedCostMinor); capacity -= BigInt(row.candidate.requiredMinutes);
  }
  const reservations = ranked.filter(row => row.selected).map(row => ({ opportunityId: row.candidate.binding.opportunityId,
    identity: row.candidate.binding.identity, costMinor: row.candidate.estimatedCostMinor, minutes: row.candidate.requiredMinutes,
    expectedBinding: row.candidate.binding, requestedStage: row.candidate.requestedStage }));
  const vector = { budgetId: input.resources.budgetId, budgetVersion: input.resources.budgetVersion,
    capacityId: input.resources.capacityId, capacityVersion: input.resources.capacityVersion, policyId: input.policy.policyId,
    policyVersion: input.policy.revision.version, policyDigest: websiteSalesPolicyDigest(input.policy) };
  const allocation = { scope: input.scope, revision: input.revision, vector, reservations,
    deduplicatedCount: input.candidates.length - byId.size,
    ranked: ranked.map(row => ({ opportunityId: row.candidate.binding.opportunityId, score: row.score, selected: row.selected, reasons: row.reasons, rationale: row.rationale })),
    remainingBudgetMinor: operationsSafe(budget), remainingMinutes: operationsSafe(capacity) };
  const result = { contractVersion: websiteSalesOperationsContract, kind: 'PORTFOLIO_PROPOSAL' as const, ...allocation, createdAt: now,
    allocationDigest: websiteSalesOperationsDigest(allocation), atomicReservationRequired: true as const, spendAuthorized: false as const, externalEffectAllowed: false as const };
  return operationsImmutable({ ...result, proposalDigest: websiteSalesOperationsDigest(result) });
}
export type WebsiteSalesPortfolioPlan = ReturnType<typeof planWebsiteSalesPortfolio>;
export function revalidateWebsiteSalesPortfolioPlan(plan: WebsiteSalesPortfolioPlan, current: unknown, now: string) {
  const { proposalDigest, ...unsigned } = plan;
  const allocation = { scope: plan.scope, revision: plan.revision, vector: plan.vector, reservations: plan.reservations,
    deduplicatedCount: plan.deduplicatedCount, ranked: plan.ranked, remainingBudgetMinor: plan.remainingBudgetMinor, remainingMinutes: plan.remainingMinutes };
  if (proposalDigest !== websiteSalesOperationsDigest(unsigned) || plan.allocationDigest !== websiteSalesOperationsDigest(allocation)
    || plan.contractVersion !== websiteSalesOperationsContract || plan.kind !== 'PORTFOLIO_PROPOSAL'
    || plan.spendAuthorized !== false || plan.externalEffectAllowed !== false || plan.atomicReservationRequired !== true) operationsFail('OPERATIONS_PORTFOLIO_INTEGRITY');
  const fresh = planWebsiteSalesPortfolio(current, now);
  return operationsImmutable({ status: fresh.allocationDigest === plan.allocationDigest ? 'CURRENT' as const : 'REPLAN_REQUIRED' as const,
    reservations: fresh.reservations, currentAllocationDigest: fresh.allocationDigest, atomicReservationRequired: true as const });
}
