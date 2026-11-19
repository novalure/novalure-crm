import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { ASSISTANT_MODES, type AssistantMode, type AssistantRequest } from "./contracts";

export function canUseCrmAiAssistant(role: string) {
  return !["viewer", "external_partner"].includes(role);
}
export function assertAssistantSession(session: AppSession, mode?: AssistantMode) {
  if (!session.authenticated || !["cookie", "database"].includes(session.source) || !canUseCrmAiAssistant(session.productRole) || !session.permissions.includes("crm:read")) {
    throw new CrmCommandError("AI_ASSISTANT_FORBIDDEN", "The CRM assistant requires an active company membership", 403);
  }
  if (mode === "pipeline_analysis" && !session.productPermissions.includes("analytics:read")) throw new CrmCommandError("AI_ASSISTANT_FORBIDDEN", "Analytics access is required", 403);
}
export function assistantTimeZone(value: unknown) {
  if (value === undefined) return "UTC";
  if (typeof value !== "string" || value.length > 80) throw new CrmCommandError("VALIDATION_ERROR", "Invalid time zone");
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new CrmCommandError("VALIDATION_ERROR", "Invalid time zone"); }
}
export function parseAssistantRequest(value: unknown): AssistantRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmCommandError("VALIDATION_ERROR", "A JSON object is required");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["mode", "prompt", "language", "projectId", "leadId", "propertyId", "sourceText", "tone", "timeZone"].includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Unknown assistant field");
  if (typeof input.mode !== "string" || !ASSISTANT_MODES.includes(input.mode as AssistantMode)) throw new CrmCommandError("VALIDATION_ERROR", "Choose an assistant task");
  if (!["de", "en", "es"].includes(String(input.language))) throw new CrmCommandError("VALIDATION_ERROR", "Choose a supported language");
  if (typeof input.prompt !== "string" || input.prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.prompt)) throw new CrmCommandError("VALIDATION_ERROR", "Check the instructions");
  if (input.sourceText !== undefined && (typeof input.sourceText !== "string" || input.sourceText.length > 6000)) throw new CrmCommandError("VALIDATION_ERROR", "The source text is too long");
  if (input.tone !== undefined && !["professional", "friendly", "concise"].includes(String(input.tone))) throw new CrmCommandError("VALIDATION_ERROR", "Choose a supported tone");
  const mode = input.mode as AssistantMode;
  const projectId = input.projectId === undefined ? undefined : assertCrmUuid(input.projectId, "projectId");
  const leadId = input.leadId === undefined ? undefined : assertCrmUuid(input.leadId, "leadId");
  const propertyId = input.propertyId === undefined ? undefined : assertCrmUuid(input.propertyId, "propertyId");
  if (mode === "lead_summary" && !leadId || mode === "property_text" && !propertyId || mode === "crm_question" && !input.prompt.trim()) throw new CrmCommandError("VALIDATION_ERROR", "Select the context or enter a question");
  if (leadId && !["lead_summary", "email_draft", "crm_question"].includes(mode) || propertyId && !["property_text", "email_draft", "crm_question"].includes(mode)) throw new CrmCommandError("VALIDATION_ERROR", "The selection does not match this task");
  return { mode, prompt: input.prompt.trim(), language: input.language as AssistantRequest["language"], ...(projectId ? { projectId } : {}), ...(leadId ? { leadId } : {}), ...(propertyId ? { propertyId } : {}), ...(input.sourceText ? { sourceText: String(input.sourceText).trim() } : {}), tone: input.tone as AssistantRequest["tone"] ?? "professional", timeZone: assistantTimeZone(input.timeZone) };
}

export function readAssistantOutput(text: string, mode: AssistantMode) {
  if (!text.trim() || text.length > 16000) throw new CrmCommandError("AI_OUTPUT_INVALID", "The AI response could not be confirmed", 502);
  if (mode !== "email_draft") return { answer: text.trim(), email: null };
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")); }
  catch { throw new CrmCommandError("AI_OUTPUT_INVALID", "The email draft could not be confirmed", 502); }
  const draft = value as { subject?: unknown; body?: unknown } | null;
  if (!draft || typeof draft.subject !== "string" || !draft.subject.trim() || draft.subject.length > 180 || /[\r\n\u0000]/u.test(draft.subject) || typeof draft.body !== "string" || !draft.body.trim() || draft.body.length > 14000) throw new CrmCommandError("AI_OUTPUT_INVALID", "The email draft could not be confirmed", 502);
  return { answer: "", email: { subject: draft.subject.trim(), body: draft.body.trim(), recipient: null as string | null } };
}
