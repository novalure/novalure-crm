// Browser-safe DTOs; the private-message extractor and draft builder stay on the server.
import type { WebsiteSalesAnswerFact, WebsiteSalesConversationDraft, WebsiteSalesConversationQuote, WebsiteSalesConversationTopic } from "./website-sales-conversation";
import type { WebsiteSalesWorkbenchWorkflow } from "./website-sales-workbench-types";

export const websiteSalesConversationContract = "website-sales-conversation-v1" as const;
export const websiteSalesConversationPath = "/api/crm/website-sales/conversation";
export const websiteSalesConversationTopics = ["SERVICES", "SCOPE", "PRICE", "DISCOUNT", "TIMING", "PROCESS", "PROOF", "PRIVACY", "OBJECTION_PRICE", "OBJECTION_TIMING", "OBJECTION_NEED", "MEETING", "ACCEPTANCE", "LEGAL_OR_CONTRACT", "GENERAL", "UNKNOWN", "OPT_OUT", "OUT_OF_OFFICE"] as const;
export type SalesConversationScope = { projectId: string; companyId: string; locationId: string };
export type SalesConversationStatus = "OPEN" | "WAITING_FOR_FACTS" | "DRAFT_READY" | "WAITING_FOR_CUSTOMER" | "STOPPED" | "HUMAN_REVIEW_REQUIRED";
export type SalesConversationOperation = "authorize_topic_extraction" | "record_answer_fact" | "record_topic" | "draft_answer" | "advance_conversation" | "stop_conversation";
export type SalesConversationAllocationProof = { allocationId: string; version: number; leaseToken: string };
export type SalesConversationCommand = SalesConversationScope & {
  contractVersion: typeof websiteSalesConversationContract;
  operation: SalesConversationOperation;
  expectedConversationVersion: number;
  expectedWorkflowVersion: number;
  idempotencyKey: string;
  correlationId: string;
  payload: Record<string, unknown>;
  allocationProof?: SalesConversationAllocationProof;
};
export type SalesConversationSummary = { id: string; version: number; status: SalesConversationStatus; stopReason: string | null; factsDigest: string };
export type SalesConversationSource = {
  messageId: string; receivedAt: string; sourceHash: string; topicCode: WebsiteSalesConversationTopic;
  language: "de" | "en"; basis: "BOUNDED_RULES" | "UNCLASSIFIED";
  blockedReason: string | null; authorized: boolean; canAuthorize: boolean;
};
export type SalesConversationTurn = {
  id: string; index: number; kind: "TOPIC_RECORDED" | "ANSWER_DRAFTED" | "CLARIFICATION_REQUIRED" | "STOP_RECORDED";
  topicTurnId: string | null; topicCode: WebsiteSalesConversationTopic; language: "de" | "en";
  sourceKind: "CANONICAL_TOPIC_EXTRACTION" | "HUMAN_RECORDED_TOPIC"; messageId: string | null;
  sourceHash: string; createdAt: string; current: boolean; draft: WebsiteSalesConversationDraft | null;
};
export type SalesConversationRead = SalesConversationScope & {
  contractVersion: typeof websiteSalesConversationContract; source: "database"; workspaceId: string;
  workflow: WebsiteSalesWorkbenchWorkflow; conversation: SalesConversationSummary | null;
  factsDigest: string; facts: { fact: WebsiteSalesAnswerFact; current: boolean }[];
  quoteBinding: WebsiteSalesConversationQuote | null; sources: SalesConversationSource[]; turns: SalesConversationTurn[];
  canWrite: boolean; canApproveFacts: boolean; canContact: false;
};
export type SalesConversationEffect = {
  workflow: WebsiteSalesWorkbenchWorkflow; conversation: SalesConversationSummary;
  topicPermissionId?: string; factId?: string; topicTurnId?: string; draftTurnId?: string; messageId?: string;
  canContact: false;
};
