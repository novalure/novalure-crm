import type { WebsiteProspectInput, WebsiteInvestmentInput } from "./website-prospect";
import type { WebsiteSalesWorkbenchWorkflow } from "./website-sales-workbench-types";
export const websiteSalesLifecycleContract = "website-sales-lifecycle-v1" as const;
export const websiteSalesLifecyclePath = "/api/crm/website-sales/lifecycle";
export type WebsiteSalesLifecycleScope = { projectId: string; companyId: string; locationId: string };
export type WebsiteSalesReplyClassification = "INTERESTED" | "QUESTION" | "OUT_OF_OFFICE" | "UNCLEAR" | "OPT_OUT";
export type WebsiteSalesLifecycleOperation = "refresh_evidence" | "authorize_reply_classification" | "ingest_reply" | "record_customer_acceptance" | "create_handoff";
export type WebsiteSalesLifecycleCommand = WebsiteSalesLifecycleScope & {
  contractVersion: typeof websiteSalesLifecycleContract; operation: WebsiteSalesLifecycleOperation;
  expectedVersion: number; idempotencyKey: string; correlationId: string; payload: Record<string, unknown>;
};
export type WebsiteSalesRefreshPayload = { prospect: WebsiteProspectInput; locationVersion: number; investmentPlan?: WebsiteInvestmentInput };
export type WebsiteSalesCustomerAcceptancePayload = {
  conceptArtifactId: string; demoArtifactId: string; sourceReference: string;
  included: string[]; excluded: string[]; acceptanceCriteria: string[]; prerequisites: string[];
};
export type WebsiteSalesInboundCandidate = { messageId: string; receivedAt: string; sourceHash: string;
  classification: WebsiteSalesReplyClassification; bodyShared: boolean; canAuthorizeClassification: boolean };
export type WebsiteSalesInboundEvent = { id: string; messageId: string; classification: WebsiteSalesReplyClassification;
  classificationBasis: "BOUNDED_SOURCE_RULES_REVIEW_REQUIRED"; nextTaskId: string | null; late: boolean; createdAt: string };
export type WebsiteSalesCustomerAcceptance = WebsiteSalesCustomerAcceptancePayload & { id: string; version: number; current: boolean; createdAt: string;
  attestationKind: "OPERATOR_RECORDED_CUSTOMER_ACCEPTANCE" };
export type WebsiteSalesHandoff = { id: string; customerAcceptanceId: string; taskId: string; createdAt: string; snapshotDigest: string; current: boolean };
export type WebsiteSalesLifecycleRead = WebsiteSalesLifecycleScope & {
  contractVersion: typeof websiteSalesLifecycleContract; source: "database"; workspaceId: string;
  workflow: WebsiteSalesWorkbenchWorkflow; inboundCandidates: WebsiteSalesInboundCandidate[]; responses: WebsiteSalesInboundEvent[];
  customerAcceptances: WebsiteSalesCustomerAcceptance[]; handoffs: WebsiteSalesHandoff[];
  canWrite: boolean; canContact: false;
};
export type WebsiteSalesLifecycleEffect = {
  workflow: WebsiteSalesWorkbenchWorkflow; refreshId?: string; newObservationId?: string; invalidatedOfferId?: string | null;
  replyPermissionId?: string; responseId?: string; messageId?: string; classification?: WebsiteSalesReplyClassification;
  nextTaskId?: string | null; customerAcceptanceId?: string; handoffId?: string; taskId?: string;
};
