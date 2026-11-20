// Browser-safe transport contract. Runtime domain code remains server-side.
export const websiteSalesOperationsContract = "website-sales-operations-v1" as const;
export const websiteSalesOperationsPath = "/api/crm/website-sales/autonomy";
export type SalesOperationsScope = { projectId: string; companyId: string; locationId: string };
export type SalesResourceGrant = { companyId: string; locationId: string; grantId: string };
export type SalesOperationsOperation = "configure_portfolio" | "plan_portfolio" | "claim_allocation" | "settle_allocation" |
  "register_price_rule" | "propose_price" | "apply_quote" | "register_financial_evidence" | "record_outcome" |
  "propose_improvement" | "review_improvement" | "promote_improvement";
export type SalesOperationsCommand = SalesOperationsScope & {
  contractVersion: typeof websiteSalesOperationsContract; operation: SalesOperationsOperation;
  expectedVersion: number; idempotencyKey: string; correlationId: string; payload: Record<string, unknown>;
  allocationProof?:{allocationId:string;version:number;leaseToken:string};
};
export type SalesPortfolio = { id: string; version: number; title: string; policyId: string;
  budgetMinor: number; capacityMinutes: number; windowStart: string; windowEnd: string;
  allocatedBudgetMinor: number; allocatedCapacityMinutes: number };
export type SalesAllocation = SalesOperationsScope & { id: string; portfolioId: string; workflowId: string; assignmentId: string;
  sealedCommand?:unknown;stageOperationId?:string|null;claimedBy?:string|null;expectedAllocationVersion?:number;version: number; stage: "DIAGNOSIS" | "CONCEPT" | "CONCEPT_ACCEPTANCE" | "DEMO" | "CONVERSATION"; amountMinor: number; capacityMinutes: number;
  status: "RESERVED" | "CLAIMED" | "COMPLETED" | "RELEASED"; expiresAt: string; decision: Record<string, unknown> };
export type SalesPolicy = { id: string; policyGroupId: string; version: number; kind: "PORTFOLIO" | "PRICING" | "IMPROVEMENT";
  label: string;settings:Record<string,unknown>; policy: Record<string, unknown>; policyDigest: string; active: boolean; createdAt: string };
export type SalesPriceQuote = SalesOperationsScope & { id: string; workflowId: string; ruleId: string; ruleVersion: number;
  version: number; status: "PROPOSED" | "APPLIED"; quoteDigest: string; quote: Record<string, unknown>;
  offerId: string; offerVersion: number; offerRevision: number; offerDigest: string; createdAt: string };
export type SalesFinancialEvidence = SalesOperationsScope & { id: string; workflowId: string; sourceId: string;
  canonicalSourceHash: string; source: Record<string, unknown>; createdAt: string };
export type SalesOutcome = SalesOperationsScope & { id: string; workflowId: string; sourceId: string; sourceDigest: string;
  event: Record<string, unknown>; createdAt: string };
export type SalesImprovement = { id: string; version: number; status: "REVIEW_REQUIRED" | "APPROVED" | "REJECTED" | "PROMOTED";
  candidateDigest: string; candidate: Record<string, unknown>; decisionId: string | null; createdAt: string };
export type SalesOperationsOpportunity = SalesOperationsScope & {workspaceId:string;opportunityId:string;workflowId:string;
 companyName:string;locationLabel:string;workflowVersion:number;evidenceDigest:string;
 status:"OBSERVED"|"QUALIFIED"|"OFFER_DRAFT"|"STOPPED";statusKind:"stored";
 qualificationStatus:"READY"|"NEEDS_CLARIFICATION"|"NURTURE";blockedReason:string|null;validUntil:string;
 /** Current role/project access only; never an investment, contact or offer approval. */
 canWrite:boolean;canContact:false};
export type SalesOperationsRead = SalesOperationsScope & { contractVersion: typeof websiteSalesOperationsContract; source: "database";
  workspaceId: string;projection:"RESOURCE"|"PORTFOLIO"; portfolio: SalesPortfolio | null; allocations: SalesAllocation[]; policies: SalesPolicy[];
  quotes: SalesPriceQuote[]; financialEvidence: SalesFinancialEvidence[]; outcomes: SalesOutcome[]; improvements: SalesImprovement[];
  opportunities:SalesOperationsOpportunity[];opportunitiesHasMore:boolean;
  conversation:{version:number;language:"de"|"en"};cohort: Record<string, unknown> | null; workflow: Record<string, unknown> | null; canApprovePolicies:boolean;canWrite: boolean; canContact: false };
export type SalesOperationsEffect = SalesOperationsScope & {workspaceId:string; allocationIds?:string[];serverReservationSkips?:{opportunityId:string;reason:string}[]; portfolioId?: string; allocationId?: string; policyId?: string; ruleId?: string; quoteId?: string;
  allocationProof?:{allocationId:string;version:number;leaseToken:string};expiresAt?:string;stageOperationId?:string;
  financialEvidenceId?: string; outcomeId?: string; improvementId?: string; decisionId?: string; version: number; canContact: false };
