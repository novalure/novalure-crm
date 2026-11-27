import { CrmCommandError, assertCrmUuid, crmCommandErrorResponse } from "@/lib/crm-command";
import { requireKnowledgeBotSession, readKnowledgeBytes } from "@/lib/knowledge-center/http";
import { AssistantError, readAssistantSnapshot, runCrmAssistant } from "@/lib/crm-ai-assistant/service";
import { assistantTimeZone, parseAssistantRequest } from "@/lib/crm-ai-assistant/policy";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function selectors(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const [key] of params) if (!["workspaceId", "projectId", "language", "timeZone"].includes(key) || params.getAll(key).length !== 1) throw new CrmCommandError("UNKNOWN_FIELD", "Unknown or duplicate assistant selector");
  const projectId = params.has("projectId") ? assertCrmUuid(params.get("projectId"), "projectId") : undefined;
  const language = params.get("language") ?? "de";
  if (!["de", "en", "es"].includes(language)) throw new CrmCommandError("VALIDATION_ERROR", "Unsupported language");
  return { projectId, language: language as "de" | "en" | "es", timeZone: assistantTimeZone(params.get("timeZone") ?? undefined) };
}
function errorResponse(error: unknown) {
  if (error instanceof AssistantError) return json({ error: "Assistant request unavailable", code: error.code, terminal: error.terminal }, error.status);
  if (error instanceof CrmCommandError || error instanceof KnowledgeCenterError) return json({ error: "Check the assistant request and permissions", code: error.code, terminal: true }, error.status);
  const response = crmCommandErrorResponse(error);
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
export async function GET(request: Request) {
  try {
    const input = selectors(request), auth = await requireKnowledgeBotSession(request, "crm:read");
    if (!auth.ok) { for (const [key, value] of Object.entries(headers)) auth.response.headers.set(key, value); return auth.response; }
    return json({ persisted: true, data: await readAssistantSnapshot(auth.session, input) });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const scope = selectors(request), auth = await requireKnowledgeBotSession(request, "crm:read");
    if (!auth.ok) { for (const [key, value] of Object.entries(headers)) auth.response.headers.set(key, value); return auth.response; }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new CrmCommandError("JSON_REQUIRED", "JSON required", 415);
    const key = request.headers.get("idempotency-key");
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(key)) throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "A UUID v4 request identity is required");
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readKnowledgeBytes(request, 16384))); }
    catch (error) { if (error && typeof error === "object" && "code" in error) throw error; throw new CrmCommandError("INVALID_JSON", "Invalid JSON"); }
    const input = parseAssistantRequest(body);
    if ((input.projectId ?? null) !== (scope.projectId ?? null)) throw new CrmCommandError("INVALID_SCOPE", "The request and selected project must match");
    const result = await runCrmAssistant(auth.session, input, key);
    return result.status === 202 ? json({ persisted: true, code: result.code, terminal: false }, 202) : json({ persisted: true, data: result.result }, result.status);
  } catch (error) { return errorResponse(error); }
}
