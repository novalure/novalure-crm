import { pricingInputSchema, pricingProposalSchema, opsTime, operationsBindingReasons, operationsFail, operationsImmutable, operationsPolicyReasons,
  operationsSafe, websiteSalesOperationsContract, websiteSalesOperationsDigest, websiteSalesPolicyDigest } from './website-sales-operations-contracts.js';

/** Versioned net-EUR negotiation proposal. Approved pricing rules never replace final OFFER/CONTRACT approval. */
export function createWebsiteSalesPriceProposal(raw: unknown, now: string) {
  const input = pricingInputSchema.parse(raw); opsTime.parse(now);
  const reasons = [...operationsPolicyReasons(input.policy, input.scope, now), ...operationsBindingReasons(input.binding, input.scope, now)];
  if (new Set(input.policy.products.map(product => product.sku)).size !== input.policy.products.length
    || new Set(input.lines.map(line => line.sku)).size !== input.lines.length) operationsFail('OPERATIONS_DUPLICATE_PRODUCT');
  if (input.previousQuoteDigest !== input.revision.previousDigest) operationsFail('OPERATIONS_PRICE_VERSION_BINDING');
  let requestedDiscountBps = input.requestedDiscountBps, counteroffers = input.priorProposal?.counteroffers ?? 0;
  const prior = input.priorProposal;
  if (input.mode === 'INITIAL' && (input.negotiationRound !== 1 || requestedDiscountBps !== 0)) operationsFail('OPERATIONS_INITIAL_QUOTE_BINDING');
  if (!prior) {
    if (input.mode !== 'INITIAL' || input.priorApplication || input.revision.version !== 1 || input.previousQuoteDigest !== null) operationsFail('OPERATIONS_PRIOR_QUOTE_REQUIRED');
    counteroffers = 0;
  } else {
    const { proposalDigest, ...unsigned } = prior;
    if (proposalDigest !== websiteSalesOperationsDigest(unsigned) || input.previousQuoteDigest !== proposalDigest
      || input.revision.version !== prior.revision.version + 1) operationsFail('OPERATIONS_PRIOR_QUOTE_INTEGRITY');
    const policyChanged = prior.policyDigest !== websiteSalesPolicyDigest(input.policy) || prior.policyId !== input.policy.policyId;
    const evidenceChanged = prior.binding.evidenceDigest !== input.binding.evidenceDigest, expired = Date.parse(prior.validUntil) <= Date.parse(now);
    if (Date.parse(prior.createdAt) > Date.parse(now)) reasons.push('PRIOR_QUOTE_IN_FUTURE');
    if (websiteSalesOperationsDigest(prior.binding.identity) !== websiteSalesOperationsDigest(input.binding.identity)
      || prior.binding.opportunityId !== input.binding.opportunityId || prior.binding.cohortAssignmentId !== input.binding.cohortAssignmentId
      || prior.binding.attributionDigest !== input.binding.attributionDigest
      || input.binding.workflowVersion < prior.binding.workflowVersion || input.binding.recordVersion < prior.binding.recordVersion) reasons.push('PRIOR_OPPORTUNITY_CHANGED');
    const sameTerms = prior.termsDigest === websiteSalesOperationsDigest(input.terms), application = input.priorApplication;
    const applied = application && application.quoteDigest === proposalDigest && application.offerId === input.terms.offerId
      && application.offerVersion === input.terms.offerVersion && application.offerDigest === input.terms.offerDigest
      && Date.parse(application.appliedAt) >= Date.parse(prior.createdAt) && Date.parse(application.appliedAt) <= Date.parse(now)
      && input.terms.offerId === prior.terms.offerId && input.terms.offerVersion > prior.terms.offerVersion
      && input.terms.scopeDigest === prior.terms.scopeDigest && input.terms.contractId === prior.terms.contractId
      && input.terms.contractVersion === prior.terms.contractVersion && input.terms.contractDigest === prior.terms.contractDigest;
    if (input.mode === 'INITIAL') {
      // A fresh series never carries a previous discount. Global revision/history remains append-only.
      counteroffers = 0;
      if ((!policyChanged && !evidenceChanged && sameTerms && !expired)
        || (applied && !policyChanged && !evidenceChanged && !expired)) reasons.push('INITIAL_RESET_NOT_REQUIRED');
    } else {
      if (input.negotiationRound !== prior.negotiationRound + 1) operationsFail('OPERATIONS_NEGOTIATION_ROUND_BINDING');
      if (prior.status === 'BLOCKED' || expired) reasons.push('CURRENT_PRIOR_QUOTE_REQUIRED');
      if (policyChanged) reasons.push('PRIOR_POLICY_CHANGED');
      if (evidenceChanged) reasons.push('PRIOR_OPPORTUNITY_CHANGED');
      if (!sameTerms && !applied) reasons.push('CURRENT_PRIOR_DRAFT_APPLICATION_REQUIRED');
    }
    if (input.mode === 'AUTO_COUNTEROFFER') {
      if (requestedDiscountBps !== 0) operationsFail('OPERATIONS_AUTO_PRICE_NOT_CALLER_CONTROLLED');
      counteroffers++;
      requestedDiscountBps = prior.requestedDiscountBps + input.policy.negotiationStepBps;
      if (input.policy.negotiationStepBps === 0 || requestedDiscountBps > 10_000 || counteroffers > input.policy.maximumCounteroffers) reasons.push('COUNTEROFFER_CAP');
      if (websiteSalesOperationsDigest(input.lines.map(({ sku, quantity }) => ({ sku, quantity })).sort((a, b) => a.sku.localeCompare(b.sku)))
        !== websiteSalesOperationsDigest(prior.lines.map(({ sku, quantity }) => ({ sku, quantity })).sort((a, b) => a.sku.localeCompare(b.sku)))) reasons.push('AUTO_COUNTEROFFER_SCOPE_CHANGED');
    }
  }
  if (input.negotiationRound > input.policy.maximumNegotiationRounds) reasons.push('NEGOTIATION_ROUND_CAP');
  if (input.terms.contractStatus === 'SIGNED') reasons.push('SIGNED_CONTRACT_RENEGOTIATION_APPROVAL_REQUIRED');
  let list = BigInt(0), minimum = BigInt(0);
  const lines = [...input.lines].sort((a, b) => a.sku.localeCompare(b.sku)).map(line => {
    const product = input.policy.products.find(item => item.sku === line.sku); if (!product) operationsFail('OPERATIONS_UNKNOWN_PRODUCT');
    if (product.minimumUnitNetPriceMinor > product.unitNetPriceMinor) operationsFail('OPERATIONS_PRICE_POLICY_RANGE');
    if (requestedDiscountBps > product.maxDiscountBps) reasons.push(`DISCOUNT_CAP:${line.sku}`);
    const base = BigInt(product.unitNetPriceMinor) * BigInt(line.quantity), discount = base * BigInt(Math.min(requestedDiscountBps, 10_000)) / BigInt(10_000);
    list += base; minimum += BigInt(product.minimumUnitNetPriceMinor) * BigInt(line.quantity);
    if (base - discount < BigInt(product.minimumUnitNetPriceMinor) * BigInt(line.quantity)) reasons.push(`MINIMUM_PRICE:${line.sku}`);
    return { sku: line.sku, quantity: line.quantity, listNetMinor: operationsSafe(base), discountMinor: operationsSafe(discount), netMinor: operationsSafe(base - discount) };
  });
  const net = lines.reduce((sum, line) => sum + BigInt(line.netMinor), BigInt(0));
  if (net < minimum || net === BigInt(0)) reasons.push('MINIMUM_NET_PRICE_REQUIRED');
  let estimatedMarginBps: number | null = null;
  if (input.estimatedDeliveryCostMinor === null) reasons.push('SOURCED_DELIVERY_COST_REQUIRED');
  else if (net > BigInt(0)) {
    const contribution = net - BigInt(input.estimatedDeliveryCostMinor), numerator = contribution * BigInt(10_000);
    const margin = Number(numerator >= BigInt(0) ? numerator / net : -((-numerator + net - BigInt(1)) / net));
    if (Number.isSafeInteger(margin)) estimatedMarginBps = margin;
    if (numerator < BigInt(input.policy.minimumMarginBps) * net) reasons.push('MINIMUM_MARGIN_REQUIRED');
  }
  const validUntil = new Date(Math.min(Date.parse(input.binding.validUntil), Date.parse(input.policy.validUntil),
    input.policy.approval ? Date.parse(input.policy.approval.validUntil) : Date.parse(now), Date.parse(now) + input.policy.maxQuoteAgeMinutes * 60_000)).toISOString();
  const result = { contractVersion: websiteSalesOperationsContract, kind: 'PRICE_PROPOSAL' as const, scope: input.scope,
    revision: input.revision, binding: input.binding, terms: input.terms, termsDigest: websiteSalesOperationsDigest(input.terms),
    policyId: input.policy.policyId, policyVersion: input.policy.revision.version, policyDigest: websiteSalesPolicyDigest(input.policy),
    mode: input.mode, counteroffers, previousQuoteDigest: input.previousQuoteDigest,
    negotiationRound: input.negotiationRound, requestedDiscountBps: Math.min(requestedDiscountBps, 10_000), lines,
    currency: 'EUR' as const, listNetMinor: operationsSafe(list), discountMinor: operationsSafe(list - net), netMinor: operationsSafe(net),
    estimatedDeliveryCostMinor: input.estimatedDeliveryCostMinor, estimatedMarginBps, createdAt: now, validUntil,
    status: reasons.length ? 'BLOCKED' as const : 'WITHIN_RULES_REQUIRES_OFFER_APPROVAL' as const, reasons,
    requiresFinalOfferApproval: true as const, requiresContractApproval: true as const, offerApprovalInvalidationRequired: true as const,
    bindingPriceAuthorized: false as const, externalEffectAllowed: false as const };
  return operationsImmutable(pricingProposalSchema.parse({ ...result, proposalDigest: websiteSalesOperationsDigest(result) }));
}
export type WebsiteSalesPriceProposal = ReturnType<typeof createWebsiteSalesPriceProposal>;
export function revalidateWebsiteSalesPriceProposal(proposal: WebsiteSalesPriceProposal, current: unknown, now: string) {
  pricingProposalSchema.parse(proposal);
  const { proposalDigest, ...unsigned } = proposal;
  if (proposalDigest !== websiteSalesOperationsDigest(unsigned)) operationsFail('OPERATIONS_PRICE_INTEGRITY');
  const fresh = createWebsiteSalesPriceProposal(current, now);
  const same = fresh.binding.evidenceDigest === proposal.binding.evidenceDigest && websiteSalesOperationsDigest(fresh.binding) === websiteSalesOperationsDigest(proposal.binding)
    && fresh.termsDigest === proposal.termsDigest && fresh.policyDigest === proposal.policyDigest && fresh.netMinor === proposal.netMinor
    && fresh.proposalDigest === createWebsiteSalesPriceProposal(current, proposal.createdAt).proposalDigest;
  return operationsImmutable({ status: same && fresh.status !== 'BLOCKED' && Date.parse(now) < Date.parse(proposal.validUntil)
    ? 'CURRENT_REQUIRES_OFFER_APPROVAL' as const : 'REPRICE_REQUIRED' as const, proposalDigest: proposal.proposalDigest, bindingPriceAuthorized: false as const });
}
