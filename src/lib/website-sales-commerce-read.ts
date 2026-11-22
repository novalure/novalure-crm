import { websiteSalesCommerceReadSchema, type CommerceIdentity } from './website-sales-commerce-types';

/** Shape and resource boundary only: CRM still authorizes every fresh query and effect. */
export function validateWebsiteSalesCommerceRead(raw: unknown, identity: CommerceIdentity, workflowId: string) {
  const data = websiteSalesCommerceReadSchema.parse(raw);
  const same = (scope: CommerceIdentity) => scope.workspaceId === identity.workspaceId && scope.projectId === identity.projectId && scope.companyId === identity.companyId && scope.locationId === identity.locationId;
  if (!same(data.identity) || data.workflowId !== workflowId) throw new Error('COMMERCE_RESPONSE_SCOPE_DENIED');
  const records = [...data.templates, ...data.offers, ...data.contracts, ...data.deliveryAcceptances, ...data.invoiceRequests, ...data.subscriptions, ...(data.policy ? [data.policy] : [])];
  for (const record of [...records, ...data.offerChoices, ...(data.policies ?? []), ...data.eligibleDeliveryTasks, ...data.outbox, ...data.sourceEvents, ...data.invoices, ...data.payments]) {
    if (!same(record.identity) || record.workflowId !== workflowId) throw new Error('COMMERCE_RESPONSE_SCOPE_DENIED');
  }
  for (const row of [...records, ...(data.policies ?? [])]) if (row.workflowVersion > data.workflowVersion) throw new Error('COMMERCE_RESPONSE_VERSION_DENIED');
  const has = (rows: { id: string; version: number; digest: string }[], ref: { id: string; version: number; digest: string }) => rows.some(row => row.id === ref.id && row.version === ref.version && row.digest === ref.digest);
  for (const approval of data.approvals) {
    const contract = data.contracts.find(row => row.id === approval.documentRef.id && row.version === approval.documentRef.version && row.digest === approval.documentRef.digest);
    if (!contract || approval.completedSteps > approval.requiredSteps || approval.documentSha256 !== contract.payload.documentSha256 || approval.recipientDigest !== contract.payload.recipientDigest) throw new Error('COMMERCE_APPROVAL_BINDING_DENIED');
  }
  for (const offer of data.offers) if (offer.id !== offer.payload.offerRef.id || offer.version !== offer.payload.offerRef.version || offer.digest !== offer.payload.offerRef.digest) throw new Error('COMMERCE_OFFER_BINDING_DENIED');
  for (const contract of data.contracts) {
    if (!has(data.offers, contract.payload.offerRef) || !has(data.templates, contract.payload.templateRef) || !has([...(data.policies ?? []), ...(data.policy ? [data.policy] : [])], contract.payload.policyRef)) throw new Error('COMMERCE_CONTRACT_BINDING_DENIED');
  }
  for (const acceptance of data.deliveryAcceptances) if (!has(data.contracts, acceptance.payload.contractRef)) throw new Error('COMMERCE_ACCEPTANCE_BINDING_DENIED');
  for (const invoice of data.invoiceRequests) if (!has(data.contracts, invoice.payload.contractRef) || invoice.payload.deliveryAcceptanceRef && !has(data.deliveryAcceptances, invoice.payload.deliveryAcceptanceRef)) throw new Error('COMMERCE_INVOICE_BINDING_DENIED');
  for (const subscription of data.subscriptions) if (!has(data.contracts, subscription.payload.contractRef)) throw new Error('COMMERCE_SUBSCRIPTION_BINDING_DENIED');
  for (const invoice of data.invoices) if (invoice.kind !== 'INVOICE' && invoice.kind !== 'CREDIT_NOTE') throw new Error('COMMERCE_INVOICE_PROJECTION_INVALID');
  for (const event of data.sourceEvents) if (event.kind === 'INVOICE') {
    const request = data.invoiceRequests.find(row => row.id === event.payload.invoiceRequestId);
    if (request && request.payload.customerReference !== event.payload.customerReference) throw new Error('COMMERCE_ACCOUNTING_CUSTOMER_BINDING_DENIED');
  }
  for (const payment of data.payments) if (!['PAYMENT', 'REFUND', 'REVERSAL'].includes(payment.kind)) throw new Error('COMMERCE_PAYMENT_PROJECTION_INVALID');
  const visibleSources = new Set(data.sourceEvents.map(event => event.eventId)), assessmentIds = [...data.sourceAssessment.activeEventIds, ...data.sourceAssessment.invalidatedEventIds];
  if (new Set(assessmentIds).size !== assessmentIds.length || assessmentIds.some(id => !visibleSources.has(id))) throw new Error('COMMERCE_SOURCE_ASSESSMENT_COVERAGE_DENIED');
  const financial = data.financialAssessment?.value;
  if (financial) {
    if ([...financial.activeSourceEventIds, ...financial.excludedOperatorEventIds].some(id => !visibleSources.has(id))) throw new Error('COMMERCE_FINANCIAL_ASSESSMENT_COVERAGE_DENIED');
    for (const position of financial.invoices) {
      const source = data.sourceEvents.find(event => event.eventId === position.invoiceSourceEventId);
      if (!source || source.kind !== 'INVOICE' || source.payload.financial.currency !== position.currency || source.payload.financial.grossMinor !== position.grossMinor || position.installments.some(row => !source.payload.installments.some(original => original.installmentId === row.installmentId && original.amountMinor === row.amountMinor))) throw new Error('COMMERCE_FINANCIAL_INVOICE_BINDING_DENIED');
    }
    if (new Set(financial.invoices.map(position => position.invoiceSourceEventId)).size !== financial.invoices.length || new Set(financial.currencies.map(row => row.currency)).size !== financial.currencies.length
      || new Set(financial.activeSourceEventIds).size !== financial.activeSourceEventIds.length || new Set(financial.excludedOperatorEventIds).size !== financial.excludedOperatorEventIds.length) throw new Error('COMMERCE_FINANCIAL_ASSESSMENT_DUPLICATE');
  }
  const unique = (rows: { id: string; version: number }[]) => new Set(rows.map(row => `${row.id}:${row.version}`)).size === rows.length;
  for (const list of [data.templates, data.offers, data.contracts, data.approvals.map(row => ({ id: row.approvalId, version: 1 })), data.outbox]) if (!unique(list)) throw new Error('COMMERCE_RESPONSE_DUPLICATE');
  return data;
}
