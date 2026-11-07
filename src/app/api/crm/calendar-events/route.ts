import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
import { calendarEventResourceId, withCrmSalesWrite } from "@/lib/crm-sales-http";
import { assertCrmFields, assertCrmUuid, CrmCommandError } from "@/lib/crm-command";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  archiveInternalCalendarEvent,
  listCalendarEventRecords,
  upsertCalendarEventRecord,
} from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getCalendarEventWriteStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (reason.includes("required") || reason.includes("Invalid") || reason.includes("too long") || reason.includes("after start")) {
    return 400;
  }
  return 503;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const result = await listCalendarEventRecords({
    contactId: url.searchParams.get("contactId"),
    leadId: url.searchParams.get("leadId"),
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getCalendarEventWriteStatus(result.reason) });
  }

  return NextResponse.json({ events: result.events, persisted: true });
}

const eventFields = ["id", "projectId", "contactId", "leadId", "ownerUserId", "title", "startsAt", "endsAt", "location", "status", "preparation", "outcomeGoal", "notes", "meetingProvider"];

async function postHandler(request: Request, session: AppSession) {
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CrmCommandError("INVALID_JSON", "JSON object required");
  const input = body as Record<string, unknown>;
  const wrapped = input.event !== undefined;
  if (wrapped && (!input.event || typeof input.event !== "object" || Array.isArray(input.event))) throw new CrmCommandError("INVALID_EVENT", "Event object required");
  if (wrapped) assertCrmFields(input, ["event", "expectedRevision", "idempotencyKey", "correlationId"]);
  const event = wrapped ? input.event as Record<string, unknown> : Object.fromEntries(Object.entries(input).filter(([key]) => !["expectedRevision", "idempotencyKey", "correlationId"].includes(key)));
  assertCrmFields(event, eventFields);
  const eventId = calendarEventResourceId(new URL(request.url), request.method, input);
  if (eventId) event.id = eventId;
  for (const key of ["id", "projectId", "contactId", "leadId", "ownerUserId"]) if (event[key] !== undefined) assertCrmUuid(event[key], key);
  for (const key of ["startsAt", "endsAt"]) if (event[key] !== undefined && (typeof event[key] !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(event[key]) || !Number.isFinite(Date.parse(event[key])))) throw new CrmCommandError("INVALID_EVENT", "Explicit valid start/end with offset required");
  if (event.status !== undefined && !["geplant", "vorbereiten", "bestätigt", "nachfassen", "abgesagt"].includes(String(event.status))) throw new CrmCommandError("INVALID_EVENT", "Invalid calendar event status");
  if (event.id && (typeof input.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedRevision))) throw new CrmCommandError("REVISION_REQUIRED", "Read the current calendar revision before editing", 409);
  const result = await upsertCalendarEventRecord({ event, session, expectedRevision: input.expectedRevision, enforceInternalCommand: true });
  if (!result.persisted) return NextResponse.json({ error: result.reason }, { status: getCalendarEventWriteStatus(result.reason) });
  return NextResponse.json({ event: result.data, persisted: true });
}

async function deleteHandler(request: Request, session: AppSession) {
  const input = await readJson(request) as Record<string, unknown> | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CrmCommandError("INVALID_JSON", "JSON object required");
  assertCrmFields(input, ["id", "eventId", "expectedRevision", "idempotencyKey", "correlationId"]);
  const eventId = calendarEventResourceId(new URL(request.url), request.method, input)!;
  if (typeof input.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedRevision)) throw new CrmCommandError("REVISION_REQUIRED", "Read the current calendar revision before removing", 409);
  const archived = await archiveInternalCalendarEvent({ session, eventId, expectedRevision: input.expectedRevision });
  return NextResponse.json({ ...archived, eventId: archived.id, persisted: true });
}

export const POST = withCrmSalesWrite(postHandler);
export const PATCH = withCrmSalesWrite(postHandler);
export const DELETE = withCrmSalesWrite(deleteHandler);
