import { websiteSalesCommerceReadSchema, type CommerceIdentity } from './website-sales-commerce-types';

/** Shape and resource boundary only: CRM still authorizes every fresh query and effect. */
export function validateWebsiteSalesCommerceRead(raw: unknown, identity: CommerceIdentity, workflowId: string) {
  const data = websiteSalesCommerceReadSchema.parse(raw);
  const same = (scope: CommerceIdentity) => scope.workspaceId === identity.workspaceId && scope.projectId === identity.projectId && scope.companyId === identity.companyId && scope.locationId === identity.locationId;
  if (!same(data.identity) || data.workflowId !== workflowId) throw new Error('COMMERCE_RESPONSE_SCOPE_DENIED');
  const records = [...data.templates, ...data.offers, ...data.contracts, ...data.deliveryAcceptances, ...data.invoiceRequests, ...data.subscriptions, ...(data.policy ? [data.policy] : [])];
  for (const record of [...records, ...(data.policies ?? []), ...data.eligibleDeliveryTasks, ...data.outbox, ...data.sourceEvents, ...data.invoices, ...data.payments]) {
    if (!same(record.identity) || record.workflowId !== workflowId) throw new Error('COMMERCE_RESPONSE_SCOPE_DENIED');
  }
  const has = (rows: { id: string; version: number; digest: string }[], ref: { id: string; version: number; digest: string }) => rows.some(row => row.id === ref.id && row.version === ref.version && row.digest === ref.digest);
  for (const approval of data.approvals) if (!has(data.contracts, approval.documentRef) || approval.completedSteps > approval.requiredSteps) throw new Error('COMMERCE_APPROVAL_BINDING_DENIED');
  for (const contract of data.contracts) {
    if (!has(data.offers, contract.payload.offerRef) || !has(data.templates, contract.payload.templateRef) || !has([...(data.policies ?? []), ...(data.policy ? [data.policy] : [])], contract.payload.policyRef)) throw new Error('COMMERCE_CONTRACT_BINDING_DENIED');
  }
  for (const invoice of data.invoices) if (invoice.kind !== 'INVOICE' && invoice.kind !== 'CREDIT_NOTE') throw new Error('COMMERCE_INVOICE_PROJECTION_INVALID');
  for (const payment of data.payments) if (!['PAYMENT', 'REFUND', 'REVERSAL'].includes(payment.kind)) throw new Error('COMMERCE_PAYMENT_PROJECTION_INVALID');
  const unique = (rows: { id: string; version: number }[]) => new Set(rows.map(row => `${row.id}:${row.version}`)).size === rows.length;
  for (const list of [data.templates, data.offers, data.contracts, data.approvals.map(row => ({ id: row.approvalId, version: 1 })), data.outbox]) if (!unique(list)) throw new Error('COMMERCE_RESPONSE_DUPLICATE');
  return data;
}
