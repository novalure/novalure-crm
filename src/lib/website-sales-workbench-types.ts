// Browser-safe contract: domain dependencies below are erased type imports only.
import type { WebsiteInvestmentDecision, WebsiteInvestmentInput, WebsiteProspectInput } from "./website-prospect";

export const websiteSalesWorkbenchContract = "website-sales-workbench-v1";
export const websiteSalesWorkbenchPath = "/api/crm/website-sales/workbench";
export type WebsiteSalesWorkbenchView = "projects" | "companies" | "contacts" | "locations" | "detail";
export type WebsiteSalesWorkbenchQuery = {
  view: WebsiteSalesWorkbenchView;
  projectId?: string;
  companyId?: string;
  locationId?: string;
  cursor?: string;
  limit?: number;
  q?: string;
};
export type WebsiteSalesWorkbenchPage = { limit: number; hasMore: boolean; nextCursor: string | null };
export type WebsiteSalesWorkbenchStatus = "OBSERVED" | "QUALIFIED" | "OFFER_DRAFT" | "STOPPED";
export type WebsiteSalesWorkbenchProject = { id: string; name: string; canWrite: boolean; pipelineConfigured: boolean };
export type WebsiteSalesWorkbenchCompany = { id: string; name: string; city: string; domain: string | null; version: number };
export type WebsiteSalesWorkbenchContact = { id: string; name: string; email: string | null; version: number };
export type WebsiteSalesStoredSummary = {
  id: string; status: WebsiteSalesWorkbenchStatus; version: number; contactId: string | null;
  evidenceDigest: string; validUntil: string; statusKind: "stored"; canContact: false;
};
export type WebsiteSalesWorkbenchLocation = {
  id: string; workspaceId: string; projectId: string; companyId: string;
  locationKey: string; countryCode: "IE"; address: string; sourceUrl: string; version: number;
  sourceReference: string; registrationBasis: "SESSION_ATTESTED"; registeredAt: string;
};
export type WebsiteSalesWorkbenchLocationItem = WebsiteSalesWorkbenchLocation & { workflow: WebsiteSalesStoredSummary | null };
export type WebsiteSalesWorkbenchWorkflow = {
  id: string; workspaceId: string; projectId: string; companyId: string; locationId: string;
  locationVersion: number; version: number; status: WebsiteSalesWorkbenchStatus; blockedReason: string | null;
  evidenceDigest: string; qualificationStatus: "READY" | "NEEDS_CLARIFICATION" | "NURTURE"; validUntil: string;
  investmentDecision: WebsiteInvestmentDecision | null; contactId: string | null; leadId: string | null;
  dealId: string | null; nextTaskId: string | null; offerDraftId: string | null; stopReason: string | null;
  lastCommandId: string; lastCorrelationId: string; canContact: false;
};
export type WebsiteSalesWorkbenchObservation = {
  prospect: WebsiteProspectInput; investmentPlan: WebsiteInvestmentInput | null;
  evidenceDigest: string; observedAt: string; validUntil: string;
};
type Scope = {
  contractVersion: typeof websiteSalesWorkbenchContract; source: "database";
  workspaceId: string; projectId: string | null; companyId: string | null;
  /** Current role/project write access only; never evidence readiness or contact authority. */
  canWrite: boolean; canContact: false;
};
export type WebsiteSalesWorkbenchProjectsResponse = Scope & { view: "projects"; items: WebsiteSalesWorkbenchProject[]; page: WebsiteSalesWorkbenchPage };
export type WebsiteSalesWorkbenchCompaniesResponse = Scope & { view: "companies"; items: WebsiteSalesWorkbenchCompany[]; page: WebsiteSalesWorkbenchPage };
export type WebsiteSalesWorkbenchContactsResponse = Scope & { view: "contacts"; items: WebsiteSalesWorkbenchContact[]; page: WebsiteSalesWorkbenchPage };
export type WebsiteSalesWorkbenchLocationsResponse = Scope & { view: "locations"; items: WebsiteSalesWorkbenchLocationItem[]; page: WebsiteSalesWorkbenchPage };
export type WebsiteSalesWorkbenchDetailResponse = Scope & {
  view: "detail"; location: WebsiteSalesWorkbenchLocation; workflow: WebsiteSalesWorkbenchWorkflow | null;
  observation: WebsiteSalesWorkbenchObservation | null; contact: WebsiteSalesWorkbenchContact | null;
};
export type WebsiteSalesWorkbenchResponse = WebsiteSalesWorkbenchProjectsResponse | WebsiteSalesWorkbenchCompaniesResponse |
  WebsiteSalesWorkbenchContactsResponse | WebsiteSalesWorkbenchLocationsResponse | WebsiteSalesWorkbenchDetailResponse;
