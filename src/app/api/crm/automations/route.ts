import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, executeCrmCommand } from "@/lib/crm-command";
import { AutomationValidationError } from "@/lib/automation/graph";
import { automationSchedulerReadiness } from "@/lib/automation/scheduler";
import { controlAutomationEnrollment, enrollAutomationLead, listAutomations, reviewAutomationDraft, runAutomationDue, saveAutomation, setAutomationStatus } from "@/lib/automation/repository";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (projectId) assertCrmUuid(projectId);
    const data = await listAutomations(auth.session, projectId);
    data.definitions = data.definitions.map((record) => {
      const schedule = automationSchedulerReadiness({ workspaceId: auth.session.workspaceId, automationId: record.id, actorId: record.scheduleActorId ?? "" }, record.scheduleGranted === true);
      return { ...record, scheduleReady: schedule.ready, scheduleReason: schedule.reason };
    });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  let correlationId: string | undefined;
  try {
    if (Number(request.headers.get("content-length")) > 150000) throw new CrmCommandError("REQUEST_TOO_LARGE", "Der Flow ist zu groß.", 413);
    const encoded = await request.text();
    if (encoded.length > 150000) throw new CrmCommandError("REQUEST_TOO_LARGE", "Der Flow ist zu groß.", 413);
    const raw: unknown = JSON.parse(encoded);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_REQUEST", "Ein JSON-Objekt ist erforderlich.");
    const input = raw as Record<string, unknown>;
    assertCrmFields(input, ["operation", "id", "name", "projectId", "graph", "expectedRevision", "active", "leadId", "dismiss", "idempotencyKey", "correlationId"]);
    if (!["save", "status", "run", "enroll", "review", "stop_run", "retry_run"].includes(String(input.operation))) throw new CrmCommandError("INVALID_OPERATION", "Unbekannte Flow-Aktion.");
    const metadata = crmRequestMetadata(request, input); correlationId = metadata.correlationId;
    const projectId = input.projectId === null || input.projectId === undefined || input.projectId === "" ? null : assertCrmUuid(input.projectId);
    const id = input.id === undefined ? undefined : assertCrmUuid(input.id);
    if (["status", "enroll", "review", "stop_run", "retry_run"].includes(String(input.operation)) && !id) throw new CrmCommandError("ID_REQUIRED", "Flow-, Lauf- oder Entwurfs-ID fehlt.");
    if (input.operation === "status" && typeof input.active !== "boolean") throw new CrmCommandError("ACTIVE_REQUIRED", "Aktivierung muss ausdrücklich angegeben werden.");
    if (input.operation === "review" && typeof input.dismiss !== "boolean") throw new CrmCommandError("REVIEW_REQUIRED", "Entscheidung muss ausdrücklich angegeben werden.");
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)) throw new CrmCommandError("INVALID_REVISION", "Gespeicherte Revision ist ungültig.");
    const result = await executeCrmCommand(auth.session, { operation: `automation.${input.operation}`, resourceId: id, projectId: projectId ?? undefined, ...metadata, capability: "pipeline:write", payload: input }, async (tx, context) => {
      if (input.operation === "save") return saveAutomation(tx, context.session, { id, projectId, name: input.name as string, graph: input.graph, expectedRevision: input.expectedRevision as number | undefined });
      if (input.operation === "status") return setAutomationStatus(tx, context.session, { id: id!, expectedRevision: input.expectedRevision as number, active: input.active as boolean });
      if (input.operation === "enroll") return enrollAutomationLead(tx, context.session, { automationId: id!, leadId: assertCrmUuid(input.leadId), eventId: `manual:${context.commandId}` });
      if (input.operation === "review") return reviewAutomationDraft(tx, context.session, { id: id!, dismiss: input.dismiss as boolean });
      if (input.operation === "stop_run" || input.operation === "retry_run") return controlAutomationEnrollment(tx, context.session, { id: id!, retry: input.operation === "retry_run" });
      return runAutomationDue(tx, context.session, projectId);
    });
    return Response.json({ ...result, persisted: true, correlationId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AutomationValidationError) return crmCommandErrorResponse(new CrmCommandError("INVALID_GRAPH", error.message), correlationId);
    return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Ungültiges JSON.") : error, correlationId);
  }
}
