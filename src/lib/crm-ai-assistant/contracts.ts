import type { AiCreditSnapshot } from "@/lib/ai-billing/repository";

export const ASSISTANT_MODES = ["daily_briefing", "pipeline_analysis", "lead_summary", "email_draft", "property_text", "crm_question"] as const;
export type AssistantMode = typeof ASSISTANT_MODES[number];
export type AssistantLanguage = "de" | "en" | "es";
export type AssistantRequest = {
  mode: AssistantMode; prompt: string; language: AssistantLanguage;
  projectId?: string; leadId?: string; propertyId?: string;
  sourceText?: string; tone?: "professional" | "friendly" | "concise"; timeZone?: string;
};
export type AssistantSource = { type: "lead" | "contact" | "task" | "meeting" | "deal" | "property" | "project"; id: string; label: string };
export type AssistantResult = {
  id: string; mode: AssistantMode; createdAt: string; status: "completed";
  answer: string; email: { subject: string; body: string; recipient: string | null } | null;
  sources: AssistantSource[]; chargedCredits: number; capturedAt: string; contextLimited?: boolean;
};
export type AssistantSnapshot = {
  source: "database"; workspaceId: string; capturedAt: string;
  scope: { projectId: string | null; label: string };
  options: { leads: { id: string; label: string }[]; properties: { id: string; label: string }[] };
  metrics: { openLeads: number; overdueTasks: number; todayMeetings: number; pipelineValueCents: number };
  credits: Pick<AiCreditSnapshot, "availableCredits" | "monthlyCredits" | "usedCredits" | "reservedCredits">;
  recentRuns: AssistantResult[]; pendingRun?: { id: string; request: AssistantRequest; createdAt: string } | null; contextLimited?: boolean; timeZone?: string; allowedModes?: AssistantMode[];
};
